import { mkdirSync, mkdtempSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInit } from "./init.js";
import { runTest } from "./test.js";

describe("@tsuba/cli test", () => {
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

  it("runs cargo test for the generated crate", async () => {
    const root = makeRepoTempDir("cli-test-");
    await runInit({ dir: root });
    const projectName = basename(root);
    const projectRoot = join(root, "packages", projectName);

    await runTest({ dir: projectRoot, stdio: "pipe" });
  });
});
