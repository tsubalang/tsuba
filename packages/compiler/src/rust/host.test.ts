import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileHostToRust } from "./host.js";

describe("@tsuba/compiler host emitter", () => {
  function getRepoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const repoRoot = getRepoRoot();
    const base = join(repoRoot, ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  it("emits a minimal Rust main() from an exported TS main()", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type Macro<Fn extends (...args: any[]) => unknown> = Fn & {",
        "  readonly __tsuba_macro: unique symbol;",
        "};",
        "declare const println: Macro<(msg: string) => void>;",
        "",
        "export function main(): void {",
        '  println("hello");',
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("fn main()");
    expect(out.mainRs).to.contain('println!("hello")');
  });

  it("lowers @tsuba/core markers (q/unsafe) and supports Result<void,E> main", () => {
    const dir = makeRepoTempDir("compiler-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { q, unsafe } from "@tsuba/core/lang.js";',
        'import { Ok } from "@tsuba/std/prelude.js";',
        'import type { Result, i32 } from "@tsuba/core/types.js";',
        "",
        "declare function mayFail(): Result<i32, i32>;",
        "",
        "export function main(): Result<void, i32> {",
        "  const x = unsafe(() => 1 as i32);",
        "  const y = q(mayFail());",
        "  return Ok();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("fn main() -> Result<(), i32>");
    expect(out.mainRs).to.contain("unsafe { (1) as i32 }");
    expect(out.mainRs).to.contain(")?");
    expect(out.mainRs).to.contain("return Ok(())");
  });

  it("emits Rust associated function calls for static class methods", () => {
    const dir = makeRepoTempDir("compiler-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { HashMap, Vec } from "@tsuba/std/prelude.js";',
        'import type { i32, String } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const v = Vec.new<i32>();",
        "  const m = HashMap.new<String, i32>();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("Vec::<i32>::new()");
    expect(out.mainRs).to.contain("std::collections::HashMap::<std::string::String, i32>::new()");
  });
});
