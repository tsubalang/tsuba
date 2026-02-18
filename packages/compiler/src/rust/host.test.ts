import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CompileError, compileHostToRust } from "./host.js";

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

  it("emits helper functions declared in the entry file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "function add(a: i32, b: i32): i32 {",
        "  return a + b;",
        "}",
        "",
        "export function main(): void {",
        "  const x = add(3 as i32, 4 as i32);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("fn add(a: i32, b: i32) -> i32");
    expect(out.mainRs).to.contain("let x = add((3) as i32, (4) as i32);");
  });

  it("supports the TS void operator as a discard expression", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "function f(): i32 {",
        "  return 1 as i32;",
        "}",
        "",
        "export function main(): void {",
        "  void f();",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("{ let _ = f(); () }");
  });

  it("emits helper functions from imported project modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    const math = join(dir, "math.ts");

    writeFileSync(
      math,
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
      entry,
      [
        "type i32 = number;",
        'import { add } from "./math.js";',
        "",
        "export function main(): void {",
        "  add(1 as i32, 2 as i32);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("fn add(a: i32, b: i32) -> i32");
  });

  it("emits imported project modules as Rust `mod` blocks and wires named imports via `use`", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    const math = join(dir, "math.ts");

    writeFileSync(
      math,
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
      entry,
      ["type i32 = number;", 'import { add } from "./math.js";', "", "export function main(): void {", "  add(1 as i32, 2 as i32);", "}", ""].join(
        "\n"
      ),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("use crate::math::add;");
    expect(out.mainRs).to.contain("mod math {");
    expect(out.mainRs).to.contain("pub fn add(a: i32, b: i32) -> i32");
  });

  it("lowers array literals to vec!(...) and supports element access", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "type usize = number;",
        "",
        "export function main(): void {",
        "  const v = [1 as i32, 2 as i32];",
        "  const x = v[0 as usize];",
        "  void x;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("let v = vec!((1) as i32, (2) as i32);");
    expect(out.mainRs).to.contain("let x = v[(0) as usize];");
  });

  it("supports while loops and assignment statements (requires mut<T> marker)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "type mut<T> = T;",
        "",
        "export function main(): void {",
        "  let x: mut<i32> = 0 as i32;",
        "  while (x < (3 as i32)) {",
        "    x = x + (1 as i32);",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("let mut x: i32 = (0) as i32;");
    expect(out.mainRs).to.contain("while (x < ((3) as i32)) {");
    expect(out.mainRs).to.contain("x = (x + ((1) as i32));");
  });

  it("supports for loops (lowered to a scoped block + while) and ++/-- in statement position", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "type mut<T> = T;",
        "",
        "export function main(): void {",
        "  for (let i: mut<i32> = 0 as i32; i < (3 as i32); i++) {",
        "    void i;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("let mut i: i32 = (0) as i32;");
    expect(out.mainRs).to.contain("while (i < ((3) as i32)) {");
    expect(out.mainRs).to.contain("i = (i + 1);");
  });

  it("maps ref/mutref marker types to Rust references (&T / &mut T / &'a T)", () => {
    const dir = makeRepoTempDir("compiler-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import type { i32, ref, mutref, refLt } from "@tsuba/core/types.js";',
        "",
        "function f(x: ref<i32>, y: mutref<i32>, z: refLt<\"a\", i32>): void {",
        "  void x;",
        "  void y;",
        "  void z;",
        "}",
        "",
        "export function main(): void {",
        "  void f;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("fn f(x: &i32, y: &mut i32, z: &'a i32)");
  });

  it("lowers a minimal class to a Rust struct + impl with constructor and methods", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-compiler-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "type mut<T> = T;",
        "type mutref<T> = T;",
        "",
        "class Counter {",
        "  value: i32 = 0 as i32;",
        "",
        "  constructor() {",
        "    this.value = 1 as i32;",
        "  }",
        "",
        "  inc(this: mutref<Counter>): void {",
        "    this.value = this.value + (1 as i32);",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  let c: mut<Counter> = new Counter();",
        "  c.inc();",
        "  void c.value;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("struct Counter {");
    expect(out.mainRs).to.contain("pub value: i32,");
    expect(out.mainRs).to.contain("impl Counter {");
    expect(out.mainRs).to.contain("pub fn new() -> Counter {");
    expect(out.mainRs).to.contain("return Counter { value: (1) as i32 }");
    expect(out.mainRs).to.contain("pub fn inc(&mut self)");
    expect(out.mainRs).to.contain("let mut c: Counter = Counter::new();");
    expect(out.mainRs).to.contain("c.inc();");
  });

  it("resolves non-relative imports via tsuba.bindings.json and records crate deps", () => {
    const dir = makeRepoTempDir("compiler-bindings-");
    const entry = join(dir, "main.ts");

    const pkgRoot = join(dir, "node_modules", "@tsuba", "fake");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@tsuba/fake", version: "0.0.1" }) + "\n", "utf-8");
    writeFileSync(join(pkgRoot, "index.js"), "export {};\n", "utf-8");
    writeFileSync(
      join(pkgRoot, "index.d.ts"),
      ["export declare class Foo {}", "export declare class Color {", "  private constructor();", "  static readonly Red: Color;", "}", ""].join("\n"),
      "utf-8"
    );
    writeFileSync(
      join(pkgRoot, "tsuba.bindings.json"),
      JSON.stringify(
        {
          schema: 1,
          kind: "crate",
          crate: { name: "fake_crate", version: "0.1.0" },
          modules: { "@tsuba/fake/index.js": "fake_crate" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    writeFileSync(
      entry,
      ['import { Foo, Color } from "@tsuba/fake/index.js";', "", "export function main(): void {", "  void Foo;", "  const c = Color.Red;", "  void c;", "}", ""].join(
        "\n"
      ),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("use fake_crate::Foo;");
    expect(out.mainRs).to.contain("use fake_crate::Color;");
    expect(out.mainRs).to.contain("Color::Red");
    expect(out.crates).to.deep.equal([{ name: "fake_crate", version: "0.1.0" }]);
  });

  it("lowers object type aliases to Rust structs and supports struct literals", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-struct-alias-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "export type Point = {",
        "  x: i32;",
        "  y: i32;",
        "};",
        "",
        "export function main(): void {",
        "  const p: Point = { x: 1, y: 2 };",
        "  void p.x;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("pub struct Point {");
    expect(out.mainRs).to.contain("pub x: i32,");
    expect(out.mainRs).to.contain("pub y: i32,");
    expect(out.mainRs).to.contain("Point { x: 1, y: 2 }");
  });

  it("generates private shape structs for untyped object literals with explicit field casts", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-shape-struct-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "export function main(): void {",
        "  const p = { x: 1 as i32, y: 2 as i32 };",
        "  void p.x;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    const m = out.mainRs.match(/struct (__Anon_[0-9a-f]{8}) \{/);
    expect(m).to.not.equal(null);
    const name = m?.[1];
    expect(name).to.be.a("string");
    expect(out.mainRs).to.contain(`${name} { x: (1) as i32, y: (2) as i32 }`);
  });

  it("errors on untyped shape object literals without explicit field casts (airplane-grade)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-shape-err-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "export function main(): void {",
        "  const p = { x: 1 };",
        "  void p;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      compileHostToRust({ entryFile: entry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CompileError);
    expect((err as CompileError).code).to.equal("TSB1131");
  });

  it("lowers discriminated union type aliases to Rust enums and switches to match", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-union-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type f64 = number;",
        "",
        "export type Shape =",
        '  | { kind: "circle"; r: f64 }',
        '  | { kind: "square"; side: f64 };',
        "",
        "function f(s: Shape): void {",
        "  switch (s.kind) {",
        '    case "circle":',
        "      void s.r;",
        "      break;",
        '    case "square":',
        "      void s.side;",
        "      break;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        '  const s: Shape = { kind: "circle", r: 1 as f64 };',
        "  f(s);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("pub enum Shape {");
    expect(out.mainRs).to.contain("Circle { r: f64 }");
    expect(out.mainRs).to.contain("Square { side: f64 }");
    expect(out.mainRs).to.contain('let s: Shape = Shape::Circle { r: (1) as f64 };');
    expect(out.mainRs).to.contain("match s {");
    expect(out.mainRs).to.contain("Shape::Circle");
  });

  it("lowers empty interfaces to marker traits and supports `implements` on classes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-trait-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "interface Foo {}",
        "",
        "class Bar implements Foo {}",
        "",
        "export function main(): void {",
        "  const b = new Bar();",
        "  void b;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("trait Foo {");
    expect(out.mainRs).to.contain("struct Bar;");
    expect(out.mainRs).to.contain("impl Foo for Bar {");
    expect(out.mainRs).to.contain("pub fn new() -> Bar");
    expect(out.mainRs).to.contain("return Bar;");
  });

  it("applies annotate(attr(...)) markers as Rust attributes on items", () => {
    const dir = makeRepoTempDir("compiler-attrs-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { annotate, attr, tokens } from "@tsuba/core/lang.js";',
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export class User {",
        "  id: i32 = 0 as i32;",
        "",
        "  constructor() {",
        "    this.id = 1 as i32;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  void User;",
        "}",
        "",
        'annotate(User, attr("repr", tokens`C`));',
        'annotate(main, attr("inline", tokens`always`));',
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("#[repr(C)]");
    expect(out.mainRs).to.contain("#[inline(always)]");
    expect(out.mainRs).to.contain("pub struct User {");
    expect(out.mainRs).to.contain("fn main()");
  });

  it("lowers kernel declarations to CUDA C source (compile-only v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    out[i] = a[i] + b[i];",
        "  }",
        "});",
        "",
        "export function main(): void {",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.kernels).to.have.length(1);
    expect(out.kernels[0]!.cuSource).to.contain('extern "C" __global__ void k(');
    expect(out.kernels[0]!.cuSource).to.contain("out[i] = (a[i] + b[i]);");
  });

  it("errors (airplane-grade) on kernel numeric literals without explicit cast", () => {
    const dir = makeRepoTempDir("compiler-kernel-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel } from "@tsuba/gpu/lang.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (n: u32): void => {',
        "  const x = 1;",
        "  void x;",
        "});",
        "",
        "export function main(): void {",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      compileHostToRust({ entryFile: entry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceof(CompileError);
    const ce = err as CompileError;
    expect(ce.code).to.equal("TSB1421");
  });
});
