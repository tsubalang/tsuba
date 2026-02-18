import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    writeFileSync(
      mainTs,
      [
        "type Macro<Fn extends (...args: any[]) => unknown> = Fn & {",
        "  readonly __tsuba_macro: unique symbol;",
        "};",
        "declare const println: Macro<(msg: string) => void>;",
        "",
        "export function main(): void {",
        '  println(\"hello\");',
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = await runRun({ dir: join(root, "packages", "demo"), stdio: "pipe" });
    expect(out.stdout).to.contain("hello");
  });
});

