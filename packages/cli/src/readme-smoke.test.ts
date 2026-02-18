import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("@tsuba/cli README smoke", function () {
  // These are full end-to-end smoke tests (init + cargo build/run). Keep them deterministic,
  // but allow enough time to compile dependencies on a cold machine.
  this.timeout(60_000);

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
});
