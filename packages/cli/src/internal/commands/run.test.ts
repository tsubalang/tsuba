import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "./init.js";
import { runRun } from "./run.js";

describe("@tsuba/cli run", function () {
  this.timeout(30_000);

  it("builds and runs the generated Rust crate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-run-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });

    const mainTs = join(root, "packages", "demo", "src", "main.ts");
    const mathTs = join(root, "packages", "demo", "src", "math.ts");

    writeFileSync(
      mathTs,
      [
        "export function touch(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      mainTs,
      [
        'import { touch } from "./math.js";',
        'declare const println: ((msg: string) => void) & { readonly __tsuba_macro: unique symbol };',
        "",
        "export function main(): void {",
        "  touch();",
        '  println(\"hello\");',
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = await runRun({ dir: join(root, "packages", "demo"), stdio: "pipe" });
    expect(out.stdout).to.contain("hello");
  });

  it("targets the project root when run is invoked from nested subdirectories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-run-nested-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });

    const projectRoot = join(root, "packages", "demo");
    const nested = join(projectRoot, "docs", "guides");
    mkdirSync(nested, { recursive: true });

    writeFileSync(
      join(projectRoot, "src", "main.ts"),
      [
        'declare const println: ((msg: string) => void) & { readonly __tsuba_macro: unique symbol };',
        "",
        "export function main(): void {",
        '  println(\"nested-run\");',
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = await runRun({ dir: nested, stdio: "pipe" });
    expect(out.stdout).to.contain("nested-run");
  });
});
