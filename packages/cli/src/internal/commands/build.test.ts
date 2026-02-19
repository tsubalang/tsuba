import { expect } from "chai";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBuild } from "./build.js";
import { runBindgen } from "./bindgen.js";
import { runInit } from "./init.js";

describe("@tsuba/cli build", function () {
  this.timeout(120_000);

  function getRepoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const repoRoot = getRepoRoot();
    const base = join(repoRoot, ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  it("generates a Rust crate for the current project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-build-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", "demo");

    await runBuild({ dir: projectRoot });

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("fn main()");
  });

  it("rejects async main unless workspace runtime.kind is tokio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-build-async-main-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", "demo");

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        "export async function main(): Promise<void> {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("runtime.kind='tokio'");
  });

  it("rejects unsupported tsuba.workspace.json schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-build-invalid-ws-"));
    const projectName = basename(root);
    await runInit({ dir: root });
    const wsPath = join(root, "tsuba.workspace.json");
    const projectRoot = join(root, "packages", projectName);
    const ws = JSON.parse(readFileSync(wsPath, "utf-8")) as Record<string, unknown>;

    ws.schema = 99;
    writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n", "utf-8");

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }

    expect(String(err)).to.contain("Unsupported tsuba.workspace.json schema.");
  });

  it("rejects unknown keys in tsuba.workspace.json (strict schema)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-build-ws-unknown-key-"));
    const projectName = basename(root);
    await runInit({ dir: root });
    const wsPath = join(root, "tsuba.workspace.json");
    const projectRoot = join(root, "packages", projectName);
    const ws = JSON.parse(readFileSync(wsPath, "utf-8")) as Record<string, unknown>;

    ws.unexpected = true;
    writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n", "utf-8");

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }

    expect(String(err)).to.contain("unknown key 'unexpected'");
  });

  it("rejects unsupported tsuba.json schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-build-invalid-project-"));
    const root = join(dir, "demo");
    await runInit({ dir: root });
    const projectRoot = join(root, "packages", "demo");
    const projectJsonPath = join(projectRoot, "tsuba.json");
    const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as Record<string, unknown>;

    project.schema = 0;
    writeFileSync(projectJsonPath, JSON.stringify(project, null, 2) + "\n", "utf-8");

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }

    expect(String(err)).to.contain("Unsupported tsuba.json schema.");
  });

  it("rejects unknown keys in tsuba.json (strict schema)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-build-project-unknown-key-"));
    const root = join(dir, "demo");
    await runInit({ dir: root });
    const projectRoot = join(root, "packages", "demo");
    const projectJsonPath = join(projectRoot, "tsuba.json");
    const project = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as Record<string, unknown>;

    project.unexpected = true;
    writeFileSync(projectJsonPath, JSON.stringify(project, null, 2) + "\n", "utf-8");

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }

    expect(String(err)).to.contain("unknown key 'unexpected'");
  });

  it("errors when imported bindings manifest is not schema-1 compatible", async () => {
    const root = makeRepoTempDir("cli-build-bad-manifest-");
    const projectName = basename(root);
    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    const pkgRoot = join(root, "node_modules", "@tsuba", "bad");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@tsuba/bad", version: "0.0.1" }) + "\n", "utf-8");
    writeFileSync(join(pkgRoot, "index.js"), "export {};\n", "utf-8");
    writeFileSync(
      join(pkgRoot, "index.d.ts"),
      ["export declare class Foo {}", "export declare function add(a: number, b: number): number;"].join("\n") + "\n",
      "utf-8"
    );
    writeFileSync(
      join(pkgRoot, "tsuba.bindings.json"),
      JSON.stringify({ schema: 99, kind: "crate", crate: { name: "bad", version: "0.0.1" }, modules: {} }, null, 2) + "\n",
      "utf-8"
    );

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      ['import { Foo, add } from "@tsuba/bad/index.js";', "", "export function main(): void {", "  const x = add(1, 2);", "  void x;", "  void Foo;", "}", ""].join(
        "\n"
      ),
      "utf-8"
    );

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }

    expect(String(err)).to.contain("unsupported schema (expected 1)");
  });

  it("produces deterministic generated output for unchanged inputs", async () => {
    const root = makeRepoTempDir("cli-build-deterministic-");
    const projectName = basename(root);
    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);
    const generatedRoot = join(projectRoot, "generated");

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const x = 1 as i32;",
        "  const y = x + (2 as i32);",
        "  if (y > x) {",
        "    // deterministic branch",
        "  }",
        "  void y;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });
    const rust1 = readFileSync(join(generatedRoot, "src", "main.rs"), "utf-8");
    const toml1 = readFileSync(join(generatedRoot, "Cargo.toml"), "utf-8");

    rmSync(generatedRoot, { recursive: true, force: true });
    await runBuild({ dir: projectRoot });
    const rust2 = readFileSync(join(generatedRoot, "src", "main.rs"), "utf-8");
    const toml2 = readFileSync(join(generatedRoot, "Cargo.toml"), "utf-8");

    expect(rust2).to.equal(rust1);
    expect(toml2).to.equal(toml1);
  });

  it("errors when kernels exist and gpu.backend is none", async () => {
    const root = makeRepoTempDir("cli-build-");
    const projectName = basename(root);

    await runInit({ dir: root });

    const projectRoot = join(root, "packages", projectName);
    const projectJsonPath = join(projectRoot, "tsuba.json");
    const projectJson = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as any;
    projectJson.gpu = { enabled: true };
    writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2) + "\n", "utf-8");

    const mainTs = join(projectRoot, "src", "main.ts");
    writeFileSync(
      mainTs,
      [
        'import { kernel } from "@tsuba/gpu/lang.js";',
        "",
        'const k = kernel({ name: "k" } as const, () => {});',
        "",
        "export function main(): void {",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("gpu.backend='none'");
  });

  it("builds a project that imports a bindings package backed by a local crate path", async () => {
    const root = makeRepoTempDir("cli-build-bindings-path-");
    const projectName = basename(root);

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    const pkgRoot = join(root, "node_modules", "@tsuba", "simple");
    mkdirSync(join(pkgRoot, "crate", "src"), { recursive: true });

    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@tsuba/simple", version: "0.0.1" }) + "\n", "utf-8");
    writeFileSync(join(pkgRoot, "index.js"), "export {};\n", "utf-8");
    writeFileSync(
      join(pkgRoot, "index.d.ts"),
      [
        "export type i32 = number;",
        "export type bool = boolean;",
        "",
        "export declare class Color {",
        "  private constructor();",
        "  static readonly Red: Color;",
        "}",
        "",
        "export declare function add(a: i32, b: i32): i32;",
        "export declare function isRed(c: Color): bool;",
        "",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(pkgRoot, "tsuba.bindings.json"),
      JSON.stringify(
        {
          schema: 1,
          kind: "crate",
          crate: { name: "simple", path: "./crate" },
          modules: { "@tsuba/simple/index.js": "simple" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    writeFileSync(
      join(pkgRoot, "crate", "Cargo.toml"),
      [
        "[package]",
        'name = "simple"',
        'version = "0.0.0"',
        'edition = "2021"',
        "",
        "[lib]",
        'path = "src/lib.rs"',
        "",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(pkgRoot, "crate", "src", "lib.rs"),
      [
        "pub struct Color;",
        "",
        "impl Color {",
        "  pub const Red: Color = Color;",
        "}",
        "",
        "pub fn add(a: i32, b: i32) -> i32 {",
        "  a + b",
        "}",
        "",
        "pub fn isRed(_c: Color) -> bool {",
        "  true",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { Color, add, isRed } from "@tsuba/simple/index.js";',
        "",
        "export function main(): void {",
        "  const c = Color.Red;",
        "  const x = add(1, 2);",
        "  if (isRed(c) && x === 3) {",
        "    // ok",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });

    const cargoToml = readFileSync(join(projectRoot, "generated", "Cargo.toml"), "utf-8");
    expect(cargoToml).to.contain('simple = { path = "');

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("use simple::Color;");
    expect(mainRs).to.contain("use simple::add;");
    expect(mainRs).to.contain("use simple::isRed;");
    expect(mainRs).to.contain("Color::Red");
  });

  it("builds a project that consumes a real tsubabindgen-generated facade package (path-backed)", async () => {
    const root = makeRepoTempDir("cli-build-bindgen-real-");
    const projectName = basename(root);

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    const repoRoot = getRepoRoot();
    const fixturePkg = join(repoRoot, "test", "fixtures", "bindgen", "@tsuba", "simple");
    const destPkg = join(root, "node_modules", "@tsuba", "simple");
    mkdirSync(dirname(destPkg), { recursive: true });
    cpSync(fixturePkg, destPkg, { recursive: true });

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { ANSWER, Point, add } from "@tsuba/simple/index.js";',
        'import { mul } from "@tsuba/simple/math.js";',
        "",
        "export function main(): void {",
        "  const p = Point.origin();",
        "  void p;",
        "  const x = add(1, 2);",
        "  const y = mul(2, 3);",
        "  if (x === 3 && y === 6 && ANSWER === 42) {",
        "    // ok",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });

    const cargoToml = readFileSync(join(projectRoot, "generated", "Cargo.toml"), "utf-8");
    expect(cargoToml).to.contain('simple_crate = { path = "');

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("use simple_crate::ANSWER;");
    expect(mainRs).to.contain("use simple_crate::Point;");
    expect(mainRs).to.contain("use simple_crate::add;");
    expect(mainRs).to.contain("use simple_crate::math::mul;");
    expect(mainRs).to.contain("Point::origin()");
  });

  it("builds a project that consumes a tsubabindgen-generated facade package (bundled crate mode)", async () => {
    const root = makeRepoTempDir("cli-build-bindgen-bundled-");
    const projectName = basename(root);

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    const repoRoot = getRepoRoot();
    const fixtureCrate = join(repoRoot, "test", "fixtures", "bindgen", "@tsuba", "simple", "crate");
    const localCrate = join(root, "local-crates", "simple-crate");
    cpSync(fixtureCrate, localCrate, { recursive: true });
    const fixtureManifest = join(localCrate, "Cargo.toml");

    await runBindgen({
      dir: root,
      argv: [
        "--manifest-path",
        fixtureManifest,
        "--out",
        "./node_modules/@tsuba/simple-bundled",
        "--package",
        "@tsuba/simple-bundled",
        "--bundle-crate",
      ],
    });

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { ANSWER, Point, add } from "@tsuba/simple-bundled/index.js";',
        'import { mul } from "@tsuba/simple-bundled/math.js";',
        "",
        "export function main(): void {",
        "  const p = Point.origin();",
        "  void p;",
        "  const x = add(1, 2);",
        "  const y = mul(2, 3);",
        "  if (x === 3 && y === 6 && ANSWER === 42) {",
        "    // ok",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });

    const cargoToml = readFileSync(join(projectRoot, "generated", "Cargo.toml"), "utf-8");
    expect(cargoToml).to.contain('simple_crate = { path = "');
    expect(cargoToml).to.contain("simple-bundled/crate");

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("use simple_crate::ANSWER;");
    expect(mainRs).to.contain("use simple_crate::Point;");
    expect(mainRs).to.contain("use simple_crate::add;");
    expect(mainRs).to.contain("use simple_crate::math::mul;");
  });

  it("maps rustc errors back to TS source spans when possible", async () => {
    const root = makeRepoTempDir("cli-build-rustc-map-");
    const projectName = basename(root);

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        "export function main(): void {",
        '  const s = "a" + "b";',
        "  void s;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("src/main.ts");
    expect(String(err)).to.contain("cargo build failed");
  });

  it("maps rustc errors from imported modules using relative span comments", async () => {
    const root = makeRepoTempDir("cli-build-rustc-map-import-");
    const projectName = basename(root);

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", projectName);

    writeFileSync(
      join(projectRoot, "src", "math.ts"),
      [
        "export function bad(): void {",
        '  const s = "x" + "y";',
        "  void s;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { bad } from "./math.js";',
        "",
        "export function main(): void {",
        "  bad();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      await runBuild({ dir: projectRoot });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("src/math.ts");
    expect(String(err)).to.contain("cargo build failed");
  });

  it("compiles kernels when gpu.backend is cuda and the project enables gpu", async () => {
    const root = makeRepoTempDir("cli-build-cuda-");
    const projectName = basename(root);

    await runInit({ dir: root });

    const cudaRoot = join(root, "fake-cuda");
    const nvccPath = join(cudaRoot, "bin", "nvcc");
    mkdirSync(join(cudaRoot, "bin"), { recursive: true });
    writeFileSync(
      nvccPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        'if [[ "${1:-}" == "--version" ]]; then',
        '  echo "Cuda compilation tools, release 12.0, V12.0.0"',
        "  exit 0",
        "fi",
        "",
        'out=""',
        'args=("$@")',
        "for ((i=0; i<${#args[@]}; i++)); do",
        '  if [[ "${args[$i]}" == "-o" ]]; then',
        '    out="${args[$((i+1))]}"',
        "  fi",
        "done",
        "",
        'if [[ -z "$out" ]]; then',
        '  echo "missing -o" >&2',
        "  exit 1",
        "fi",
        "",
        'echo "// fake ptx" > "$out"',
        "",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(nvccPath, 0o755);

    const wsPath = join(root, "tsuba.workspace.json");
    const ws = JSON.parse(readFileSync(wsPath, "utf-8")) as any;
    ws.gpu = { backend: "cuda", cuda: { toolkitPath: cudaRoot, sm: 80 } };
    writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n", "utf-8");

    const projectRoot = join(root, "packages", projectName);
    const projectJsonPath = join(projectRoot, "tsuba.json");
    const projectJson = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as any;
    projectJson.gpu = { enabled: true };
    writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2) + "\n", "utf-8");

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    out[i] = a[i] + b[i];",
        "  }",
        "});",
        "",
        "export function main(): void {",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });

    const ptx = join(projectRoot, "generated", "kernels", "k.ptx");
    expect(existsSync(ptx)).to.equal(true);

    const cu = readFileSync(join(projectRoot, "generated", "kernels", "k.cu"), "utf-8");
    expect(cu).to.contain('extern "C" __global__ void k(');
    expect(cu).to.contain("out[i] = (a[i] + b[i]);");
  });

  it("builds a project that launches a kernel (cuda backend)", async () => {
    const root = makeRepoTempDir("cli-build-cuda-launch-");
    const projectName = basename(root);

    await runInit({ dir: root });

    const cudaRoot = join(root, "fake-cuda");
    const nvccPath = join(cudaRoot, "bin", "nvcc");
    mkdirSync(join(cudaRoot, "bin"), { recursive: true });
    writeFileSync(
      nvccPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "",
        'if [[ "${1:-}" == "--version" ]]; then',
        '  echo "Cuda compilation tools, release 12.0, V12.0.0"',
        "  exit 0",
        "fi",
        "",
        'out=""',
        'args=("$@")',
        "for ((i=0; i<${#args[@]}; i++)); do",
        '  if [[ "${args[$i]}" == "-o" ]]; then',
        '    out="${args[$((i+1))]}"',
        "  fi",
        "done",
        "",
        'if [[ -z "$out" ]]; then',
        '  echo \"missing -o\" >&2',
        "  exit 1",
        "fi",
        "",
        'echo \"// fake ptx\" > \"$out\"',
        "",
        "exit 0",
        "",
      ].join("\n"),
      "utf-8"
    );
    chmodSync(nvccPath, 0o755);

    const wsPath = join(root, "tsuba.workspace.json");
    const ws = JSON.parse(readFileSync(wsPath, "utf-8")) as any;
    ws.gpu = { backend: "cuda", cuda: { toolkitPath: cudaRoot, sm: 80 } };
    writeFileSync(wsPath, JSON.stringify(ws, null, 2) + "\n", "utf-8");

    const projectRoot = join(root, "packages", projectName);
    const projectJsonPath = join(projectRoot, "tsuba.json");
    const projectJson = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as any;
    projectJson.gpu = { enabled: true };
    writeFileSync(projectJsonPath, JSON.stringify(projectJson, null, 2) + "\n", "utf-8");

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'import { kernel, threadIdxX, blockIdxX, blockDimX, deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    out[i] = a[i] + b[i];",
        "  }",
        "});",
        "",
        "export function main(): void {",
        "  const n = 256 as u32;",
        "  const a = deviceMalloc<f32>(n);",
        "  k.launch({ grid: [1, 1, 1], block: [256, 1, 1] } as const, a, a, a, n);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runBuild({ dir: projectRoot });

    const ptx = join(projectRoot, "generated", "kernels", "k.ptx");
    expect(existsSync(ptx)).to.equal(true);

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("mod __tsuba_cuda {");
    expect(mainRs).to.contain('include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/kernels/k.ptx"))');
    expect(mainRs).to.contain("__tsuba_cuda::launch_k(1, 1, 1, 256, 1, 1");
  });

  it("uses the nearest workspace config when workspaces are nested", async () => {
    const outerRoot = mkdtempSync(join(tmpdir(), "tsuba-build-nested-workspaces-"));
    const innerRoot = join(outerRoot, "inner");
    await runInit({ dir: innerRoot });

    writeFileSync(
      join(outerRoot, "tsuba.workspace.json"),
      JSON.stringify(
        {
          schema: 1,
          rustEdition: "2021",
          packagesDir: "packages",
          generatedDirName: "outer-generated",
          cargoTargetDir: ".tsuba/target",
          gpu: { backend: "none" },
          runtime: { kind: "none" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const projectRoot = join(innerRoot, "packages", "inner");
    await runBuild({ dir: join(projectRoot, "src") });

    expect(existsSync(join(projectRoot, "generated", "src", "main.rs"))).to.equal(true);
    expect(existsSync(join(projectRoot, "outer-generated", "src", "main.rs"))).to.equal(false);
  });
});
