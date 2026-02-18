import { expect } from "chai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileHostToRust } from "./host.js";

describe("@tsuba/compiler host emitter", () => {
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
});
