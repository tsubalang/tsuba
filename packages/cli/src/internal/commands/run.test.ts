import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "./init.js";
import { runRun } from "./run.js";

describe("@tsuba/cli run", () => {
  it("builds and runs the generated Rust crate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-run-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });

    const mainTs = join(root, "packages", "demo", "src", "main.ts");
    const mathTs = join(root, "packages", "demo", "src", "math.ts");

    writeFileSync(
      mathTs,
      [
        "type i32 = number;",
        "",
        "export function add(a: i32, b: i32): i32 {",
        "  return a + b;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      mainTs,
      [
        "type i32 = number;",
        "",
        "type Macro<Fn extends (...args: any[]) => unknown> = Fn & {",
        "  readonly __tsuba_macro: unique symbol;",
        "};",
        "declare const println: Macro<(msg: string) => void>;",
        "",
        'import { add } from "./math.js";',
        "",
        "export function main(): void {",
        "  add(3 as i32, 4 as i32);",
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
        "type Macro<Fn extends (...args: any[]) => unknown> = Fn & {",
        "  readonly __tsuba_macro: unique symbol;",
        "};",
        "declare const println: Macro<(msg: string) => void>;",
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
