import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("@tsuba/cli README smoke", function () {
  // These are full end-to-end smoke tests (init + cargo build/run). Keep them deterministic,
  // but allow enough time to compile dependencies on a cold machine.
  this.timeout(180_000);

  function getDistBinPath(): string {
    const here = fileURLToPath(import.meta.url);
    // dist/readme-smoke.test.js → dist/bin.js
    return resolve(join(dirname(here), "bin.js"));
  }

  function runBin(cwd: string, args: readonly string[]): void {
    const bin = getDistBinPath();
    const res = spawnSync("node", [bin, ...args], { cwd, encoding: "utf-8" });
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    expect(res.status, `${stdout}${stderr}`).to.equal(0);
  }

  it("can init/build/run a fresh workspace using the CLI binary", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-readme-smoke-"));
    runBin(root, ["init"]);

    const projectName = basename(root);
    const projectRoot = join(root, "packages", projectName);
    runBin(projectRoot, ["build"]);
    runBin(projectRoot, ["run"]);
  });

  it("can run documented add path/bindgen/test workflow in a clean temp workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-readme-deps-"));
    runBin(root, ["init"]);

    const projectName = basename(root);
    const projectRoot = join(root, "packages", projectName);

    const crateRoot = join(root, "local-crates", "simple-crate");
    mkdirSync(join(crateRoot, "src"), { recursive: true });
    writeFileSync(
      join(crateRoot, "Cargo.toml"),
      [
        "[package]",
        'name = "simple-crate"',
        'version = "0.1.0"',
        'edition = "2021"',
        "",
        "[lib]",
        'name = "simple_crate"',
        'path = "src/lib.rs"',
        "",
      ].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(crateRoot, "src", "lib.rs"),
      [
        "pub fn add(a: i32, b: i32) -> i32 {",
        "    a + b",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    runBin(projectRoot, ["add", "path", "simple_crate", "../../local-crates/simple-crate"]);
    runBin(projectRoot, ["build"]);
    runBin(projectRoot, ["test"]);

    const cfg = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as {
      deps?: { crates?: readonly { id: string; path?: string }[] };
    };
    const dep = cfg.deps?.crates?.find((d) => d.id === "simple_crate");
    expect(dep, "Expected path crate dependency in tsuba.json").to.not.equal(undefined);
    expect(dep?.path?.includes("node_modules/@tsuba/")).to.equal(true);

    const outDir = join(root, "bindings-out");
    runBin(root, [
      "bindgen",
      "--manifest-path",
      "./local-crates/simple-crate/Cargo.toml",
      "--out",
      "./bindings-out",
      "--package",
      "@tsuba/simple-crate",
    ]);

    expect(existsSync(join(outDir, "package.json"))).to.equal(true);
    expect(existsSync(join(outDir, "tsuba.bindings.json"))).to.equal(true);
    expect(existsSync(join(outDir, "index.d.ts"))).to.equal(true);
  });
});
