import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "chai";

import { runGenerate } from "./generate.js";

describe("@tsuba/tsubabindgen", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "../../../");
  }

  function runTempFixture(options: {
    readonly fixture: "simple" | "traits";
    readonly packageName?: string;
    readonly bundleCrate?: boolean;
  }): string {
    const root = repoRoot();
    const fixtureCrateDir = join(root, "test", "fixtures", "bindgen", "@tsuba", options.fixture, "crate");
    const fixtureManifest = join(fixtureCrateDir, "Cargo.toml");
    const tmpRoot = mkdtempSync(join(tmpdir(), "tsubabindgen-fixture-"));
    const copiedCrateDir = join(tmpRoot, "crate-src");
    const copiedManifest = join(copiedCrateDir, "Cargo.toml");
    const out = join(tmpRoot, "out");
    cpSync(fixtureCrateDir, copiedCrateDir, { recursive: true });
    mkdirSync(out, { recursive: true });
    runGenerate({
      manifestPath: copiedManifest,
      outDir: out,
      packageName: options.packageName,
      bundleCrate: options.bundleCrate ?? false,
    });
    expect(existsSync(join(fixtureCrateDir, "Cargo.lock"))).to.equal(false);
    expect(fixtureManifest).to.equal(join(fixtureCrateDir, "Cargo.toml"));
    return out;
  }

  function read(fileName: string): string {
    return readFileSync(fileName, "utf-8");
  }

  afterEach(() => {
    for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("tsubabindgen-fixture-")) continue;
      rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
    }
  });

  it("generates expected bindings for fixture crate", () => {
    const out = runTempFixture({ fixture: "simple", packageName: "@tsuba/simple", bundleCrate: false });
    const manifestText = read(join(out, "tsuba.bindings.json"));
    const manifest = JSON.parse(manifestText) as {
      schema: number;
      kind: string;
      crate: { name: string; package: string; version?: string; path?: string };
      modules: Record<string, string>;
    };
    expect(manifest.schema).to.equal(1);
    expect(manifest.kind).to.equal("crate");
    expect(manifest.crate.name).to.equal("simple_crate");
    expect(manifest.crate.package).to.equal("simple-crate");
    expect(manifest.crate.path).to.equal(undefined);
    expect(manifest.modules).to.deep.equal({
      "@tsuba/simple/index.js": "simple_crate",
      "@tsuba/simple/math.js": "simple_crate::math",
    });

    const packageJson = JSON.parse(read(join(out, "package.json"))) as {
      name: string;
      exports: Record<string, { types: string; default: string }>;
    };
    expect(packageJson.name).to.equal("@tsuba/simple");
    expect(packageJson.exports["./index.js"]).to.deep.equal({ types: "./index.d.ts", default: "./index.js" });
    expect(packageJson.exports["./math.js"]).to.deep.equal({ types: "./math.d.ts", default: "./math.js" });

    const rootDts = read(join(out, "index.d.ts"));
    expect(rootDts).to.include("export const ANSWER: i32;");
    expect(rootDts).to.include("export declare class Point");
    expect(rootDts).to.include("export function add(");
    expect(rootDts).to.include("constructor(x: i32, y: i32);");
    expect(rootDts).to.include("sum(): i32;");
    expect(rootDts).to.include("static origin(): Point;");
    expect(rootDts).to.not.include("export function new_");
    expect(rootDts).to.not.include("export function sum(");

    const mathDts = read(join(out, "math.d.ts"));
    expect(mathDts).to.include("export function mul(a: i32, b: i32): i32;");

    expect(read(join(out, "index.js"))).to.include("type-only");
    expect(read(join(out, "math.js"))).to.include("type-only");

    const report = JSON.parse(read(join(out, "tsubabindgen.report.json"))) as { skipped: unknown[] };
    expect((report as { schema?: number }).schema).to.equal(1);
    expect(report.skipped).to.deep.equal([]);
    expect(existsSync(join(out, "crate"))).to.equal(false);
  });

  it("copies crate when --bundle-crate is used", () => {
    const out = runTempFixture({ fixture: "simple", packageName: "@tsuba/simple", bundleCrate: true });
    const manifest = JSON.parse(read(join(out, "tsuba.bindings.json"))) as {
      crate: { path?: string };
    };
    expect(manifest.crate.path).to.equal("./crate");
    expect(existsSync(join(out, "crate", "Cargo.toml"))).to.equal(true);
    expect(existsSync(join(out, "crate", "src", "lib.rs"))).to.equal(true);
  });

  it("generates trait facades (including associated types as generics) and reports skipped unsupported types", () => {
    const out = runTempFixture({ fixture: "traits", packageName: "@tsuba/traits", bundleCrate: false });
    const rootDts = read(join(out, "index.d.ts"));
    expect(rootDts).to.include("export interface Reader {");
    expect(rootDts).to.include("read(this: ref<this>): i32;");
    expect(rootDts).to.include("export interface IteratorLike<Item> {");
    expect(rootDts).to.include("next(this: mutref<this>): Option<Item>;");
    expect(rootDts).to.include("export interface Mapper<T> extends IteratorLike {");
    expect(rootDts).to.include("map_one(this: ref<this>, value: T): Option<T>;");

    const report = JSON.parse(read(join(out, "tsubabindgen.report.json"))) as {
      schema: number;
      skipped: Array<{ kind: string; reason: string }>;
    };
    expect(report.schema).to.equal(1);
    expect(report.skipped.some((entry) => entry.kind === "type")).to.equal(true);
  });
});
