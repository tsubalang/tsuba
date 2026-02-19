import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileHostToRust } from "./host.js";

describe("@tsuba/compiler function semantics matrix", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  it("covers generic bounds + explicit returns + async function declarations", () => {
    const dir = makeRepoTempDir("compiler-fn-matrix-async-generic-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import type { i32, ref } from "@tsuba/core/types.js";',
        "",
        "interface Ordered {",
        "  rank(this: ref<this>): i32;",
        "}",
        "",
        "class Score implements Ordered {",
        "  value: i32 = 0 as i32;",
        "  constructor(value: i32) {",
        "    this.value = value;",
        "  }",
        "  rank(this: ref<Score>): i32 {",
        "    return this.value;",
        "  }",
        "}",
        "",
        "function pickHigher<T extends Ordered>(left: T, right: T): T {",
        "  if (left.rank() > right.rank()) {",
        "    return left;",
        "  }",
        "  return right;",
        "}",
        "",
        "async function computeBest(): Promise<i32> {",
        "  const winner = pickHigher(new Score(3 as i32), new Score(2 as i32));",
        "  return winner.value;",
        "}",
        "",
        "export async function main(): Promise<void> {",
        "  const score = await computeBest();",
        "  void score;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry, runtimeKind: "tokio" });
    expect(out.mainRs).to.contain("fn pickHigher<T: Ordered>(left: T, right: T) -> T");
    expect(out.mainRs).to.contain("async fn computeBest() -> i32");
    expect(out.mainRs).to.contain("#[tokio::main]");
    expect(out.mainRs).to.contain("async fn main()");
  });

  it("covers receiver semantics across class methods and trait impls", () => {
    const dir = makeRepoTempDir("compiler-fn-matrix-receivers-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import type { i32, mut, mutref, ref } from "@tsuba/core/types.js";',
        "",
        "interface CounterOps {",
        "  bump(this: mutref<this>, by: i32): i32;",
        "  read(this: ref<this>): i32;",
        "}",
        "",
        "class Counter implements CounterOps {",
        "  value: i32 = 0 as i32;",
        "  bump(this: mutref<Counter>, by: i32): i32 {",
        "    this.value = (this.value + by) as i32;",
        "    return this.value;",
        "  }",
        "  read(this: ref<Counter>): i32 {",
        "    return this.value;",
        "  }",
        "}",
        "",
        "function touch(c: mutref<Counter>): i32 {",
        "  return c.bump(1 as i32);",
        "}",
        "",
        "function inspect(c: ref<Counter>): i32 {",
        "  return c.read();",
        "}",
        "",
        "export function main(): void {",
        "  let c: mut<Counter> = new Counter();",
        "  const a = touch(c);",
        "  const b = inspect(c);",
        "  void a;",
        "  void b;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("impl CounterOps for Counter");
    expect(out.mainRs).to.contain("fn touch(c: &mut Counter) -> i32");
    expect(out.mainRs).to.contain("return c.bump((1) as i32);");
    expect(out.mainRs).to.contain("fn inspect(c: &Counter) -> i32");
    expect(out.mainRs).to.contain("return c.read();");
    expect(out.mainRs).to.contain("let a = touch(&mut (c));");
    expect(out.mainRs).to.contain("let b = inspect(&(c));");
  });

  it("covers closure matrix for expression, move, block, and defaulted closures", () => {
    const dir = makeRepoTempDir("compiler-fn-matrix-closures-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { move } from "@tsuba/core/lang.js";',
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const a = (x: i32): i32 => (x + (1 as i32)) as i32;",
        "  const b = move((x: i32): i32 => (x + (2 as i32)) as i32);",
        "  const c = (x: i32 = 3 as i32): i32 => {",
        "    const y = (x + (1 as i32)) as i32;",
        "    return y;",
        "  };",
        "  const one = a(1 as i32);",
        "  const two = b(2 as i32);",
        "  const three = c();",
        "  const four = c(4 as i32);",
        "  void one;",
        "  void two;",
        "  void three;",
        "  void four;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("let a = |x: i32|");
    expect(out.mainRs).to.contain("let b = move |x: i32|");
    expect(out.mainRs).to.contain("let c = |x: Option<i32>|");
    expect(out.mainRs).to.contain("let x: i32 = x.unwrap_or((3) as i32);");
    expect(out.mainRs).to.contain("let one = a((1) as i32);");
    expect(out.mainRs).to.contain("let two = b((2) as i32);");
    expect(out.mainRs).to.contain("let three = c(None);");
    expect(out.mainRs).to.contain("let four = c(Some((4) as i32));");
  });
});
