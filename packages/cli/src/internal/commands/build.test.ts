import { expect } from "chai";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
