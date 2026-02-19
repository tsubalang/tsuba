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
    readonly fixture: "simple" | "traits" | "advanced" | "edge";
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

  function snapshotDir(root: string): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    const visit = (dir: string, relPrefix: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
        if (entry.isDirectory()) {
          visit(abs, rel);
          continue;
        }
        out[rel] = read(abs);
      }
    };
    visit(root, "");
    return out;
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

  it("is deterministic across repeated generations", () => {
    const outA = runTempFixture({ fixture: "advanced", packageName: "@tsuba/advanced", bundleCrate: false });
    const outB = runTempFixture({ fixture: "advanced", packageName: "@tsuba/advanced", bundleCrate: false });
    expect(snapshotDir(outA)).to.deep.equal(snapshotDir(outB));
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

  it("generates advanced facades with generic methods, macros, and enum payload reporting", () => {
    const out = runTempFixture({ fixture: "advanced", packageName: "@tsuba/advanced", bundleCrate: false });
    const rootDts = read(join(out, "index.d.ts"));
    const nestedDts = read(join(out, "nested.d.ts"));

    expect(rootDts).to.include("export declare class Wrapper<T> {");
    expect(rootDts).to.include("constructor(value: T);");
    expect(rootDts).to.include("map<U>(value: U): U;");
    expect(rootDts).to.include("export declare class Payload<T> {");
    expect(rootDts).to.include("static readonly One: Payload<T>;");
    expect(rootDts).to.include("export interface Service<T, Output> extends Clone {");
    expect(rootDts).to.include("run(this: ref<this>, input: T): Output;");
    expect(rootDts).to.include("export function fold_pair<T>(left: T, _right: T): T;");
    expect(rootDts).to.include("export function make_pair(tokens: Tokens): Tokens;");

    expect(nestedDts).to.include("export const NESTED_ANSWER: i32;");
    expect(nestedDts).to.include("export function nested_mul<T>(value: T): T;");

    const report = JSON.parse(read(join(out, "tsubabindgen.report.json"))) as {
      schema: number;
      skipped: Array<{ kind: string; reason: string }>;
    };
    expect(report.schema).to.equal(1);
    expect(
      report.skipped.some(
        (entry) => entry.kind === "enum" && entry.reason.includes("payload")
      )
    ).to.equal(true);
  });

  it("reports unsupported edge syntax deterministically while still emitting usable modules", () => {
    const out = runTempFixture({ fixture: "edge", packageName: "@tsuba/edge", bundleCrate: false });
    const rootDts = read(join(out, "index.d.ts"));
    const deepDts = read(join(out, "deep.d.ts"));

    expect(rootDts).to.include("export declare class Event {");
    expect(rootDts).to.include("static readonly Ready: Event;");
    expect(rootDts).to.include("export interface Borrowing<Item> {");
    expect(rootDts).to.include("get(this: ref<this>): Option<refLt<\"a\", Item>>;");
    expect(rootDts).to.include("export declare class Bytes {");
    expect(rootDts).to.include("data: ArrayN<u8, number>;");
    expect(rootDts).to.include("export function first(value: refLt<\"a\", Str>): refLt<\"a\", Str>;");
    expect(rootDts).to.include("export function take_iter(value: unknown): i32;");
    expect(deepDts).to.include("export interface DeepTrait<T> extends Clone {");
    expect(deepDts).to.include("map(this: ref<this>, value: T): Option<T>;");

    const report = JSON.parse(read(join(out, "tsubabindgen.report.json"))) as {
      schema: number;
      skipped: Array<{ kind: string; reason: string; snippet: string }>;
    };
    expect(report.schema).to.equal(1);
    expect(report.skipped.some((entry) => entry.kind === "generic" && entry.snippet.includes("'a"))).to.equal(true);
    expect(report.skipped.some((entry) => entry.kind === "generic" && entry.snippet.startsWith("const "))).to.equal(true);
    expect(report.skipped.some((entry) => entry.kind === "enum" && entry.reason.includes("payload"))).to.equal(true);
    expect(report.skipped.some((entry) => entry.kind === "type" && entry.snippet.includes("impl Iterator"))).to.equal(
      true
    );
    expect(report.skipped.some((entry) => entry.kind === "type" && entry.reason.includes("Array length"))).to.equal(
      true
    );
  });
});
