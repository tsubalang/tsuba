import { expect } from "chai";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runBuild } from "./build.js";
import { runInit } from "./init.js";

describe("@tsuba/cli build", () => {
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

    await runBuild({ dir: projectRoot });

    const ptx = join(projectRoot, "generated", "kernels", "k.ptx");
    expect(existsSync(ptx)).to.equal(true);
  });
});
