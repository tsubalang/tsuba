import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInit } from "./init.js";
import { runTest } from "./test.js";

describe("@tsuba/cli test", function () {
  this.timeout(30_000);

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

  it("targets the project root when test is invoked from nested subdirectories", async () => {
    const root = makeRepoTempDir("cli-test-nested-");
    await runInit({ dir: root });
    const projectName = basename(root);
    const projectRoot = join(root, "packages", projectName);
    const nested = join(projectRoot, "docs", "notes");
    mkdirSync(nested, { recursive: true });

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        "type i32 = number;",
        "",
        "function add(a: i32, b: i32): i32 {",
        "  return (a + b) as i32;",
        "}",
        "",
        "export function main(): void {",
        "  void add(1 as i32, 2 as i32);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    await runTest({ dir: nested, stdio: "pipe" });
  });
});
