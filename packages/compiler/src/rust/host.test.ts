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

  it("borrows arguments when calling functions that expect ref/mutref", () => {
    const dir = makeRepoTempDir("compiler-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import type { i32, ref, mut, mutref } from "@tsuba/core/types.js";',
        "",
        "function f(x: ref<i32>, y: mutref<i32>): void {",
        "  void x;",
        "  void y;",
        "}",
        "",
        "export function main(): void {",
        "  const a: i32 = 1 as i32;",
        "  let b: mut<i32> = 2 as i32;",
        "  f(a, b);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("f(&(a), &mut (b));");
  });

  it("errors on generic function declarations (airplane-grade)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-generic-fn-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "export function main(): void {",
        "  void 0;",
        "}",
        "",
        "function id<T>(x: T): T {",
        "  return x;",
        "}",
        "",
        "export function add(a: i32, b: i32): i32 {",
        "  return (a + b) as i32;",
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
    expect((err as CompileError).code).to.equal("TSB3005");
  });

  it("emits turbofish calls for explicit type arguments on declared functions (v0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-turbofish-"));
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "type i32 = number;",
        "",
        "declare function id<T>(x: T): T;",
        "",
        "export function main(): void {",
        "  const x = id<i32>(1 as i32);",
        "  void x;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("id::<i32>((1) as i32)");
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

  it("allows numeric literals only when explicitly cast in kernel code (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-cast-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  const x = 1 as u32;",
        "  out[threadIdxX()] = x;",
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
    expect(out.kernels[0]!.cuSource).to.contain("const uint32_t x = ((uint32_t)(1));");
  });

  it("lowers shared memory + barriers + atomics in kernel code (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-shared-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, sharedArray, syncthreads, atomicAdd, addr } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  const smem = sharedArray<u32, 256>();",
        "  const tid = threadIdxX();",
        "  smem[tid] = tid;",
        "  syncthreads();",
        "  atomicAdd(addr(out, 0 as u32), smem[0 as u32]);",
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
    expect(out.kernels[0]!.cuSource).to.contain("__shared__ uint32_t __tsuba_smem0[256];");
    expect(out.kernels[0]!.cuSource).to.contain("__syncthreads();");
    expect(out.kernels[0]!.cuSource).to.contain("atomicAdd((&(out[((uint32_t)(0))])), smem[((uint32_t)(0))])");
  });

  it("supports scalar assignments and for-loops in kernel code (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-for-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, blockIdxX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>): void => {',
        "  const row = blockIdxX();",
        "  const col = threadIdxX();",
        "  let sum = 0.0 as f32;",
        "  for (let kk = 0 as u32; kk < (4 as u32); kk++) {",
        "    sum = sum + a[row * (4 as u32) + kk] * b[kk * (4 as u32) + col];",
        "  }",
        "  out[row * (4 as u32) + col] = sum;",
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
    expect(out.kernels[0]!.cuSource).to.contain("for (uint32_t kk = ((uint32_t)(0));");
    expect(out.kernels[0]!.cuSource).to.contain("kk++");
    expect(out.kernels[0]!.cuSource).to.contain("sum = (sum + (a[");
  });

  it("lowers a shared-memory tiled matmul kernel (v0 credibility, compile-only)", () => {
    const dir = makeRepoTempDir("compiler-kernel-matmul-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, threadIdxY, blockIdxX, blockIdxY, blockDimX, blockDimY, sharedArray, syncthreads } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const matmul = kernel({ name: "matmul" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const TILE = 16 as u32;",
        "  const tileA = sharedArray<f32, 256>();",
        "  const tileB = sharedArray<f32, 256>();",
        "",
        "  const row = (blockIdxY() * blockDimY() + threadIdxY()) as u32;",
        "  const col = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "",
        "  let sum = 0.0 as f32;",
        "  for (let t = 0 as u32; t < (n / TILE); t++) {",
        "    const aCol = (t * TILE + threadIdxX()) as u32;",
        "    const bRow = (t * TILE + threadIdxY()) as u32;",
        "    tileA[threadIdxY() * TILE + threadIdxX()] = a[row * n + aCol];",
        "    tileB[threadIdxY() * TILE + threadIdxX()] = b[bRow * n + col];",
        "    syncthreads();",
        "    for (let kk = 0 as u32; kk < TILE; kk++) {",
        "      sum = sum + tileA[threadIdxY() * TILE + kk] * tileB[kk * TILE + threadIdxX()];",
        "    }",
        "    syncthreads();",
        "  }",
        "  out[row * n + col] = sum;",
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
    expect(out.kernels[0]!.cuSource).to.contain("__shared__ float __tsuba_smem0[256];");
    expect(out.kernels[0]!.cuSource).to.contain("__shared__ float __tsuba_smem1[256];");
    expect(out.kernels[0]!.cuSource).to.contain("__syncthreads();");
    expect(out.kernels[0]!.cuSource).to.contain("for (uint32_t t = ((uint32_t)(0));");
    expect(out.kernels[0]!.cuSource).to.contain("for (uint32_t kk = ((uint32_t)(0));");
  });

  it("lowers a numerically-stable softmax kernel (v0 credibility, compile-only)", () => {
    const dir = makeRepoTempDir("compiler-kernel-softmax-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, blockDimX, sharedArray, syncthreads, expf } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'const softmax = kernel({ name: "softmax" } as const, (xs: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const tid = threadIdxX();",
        "  const smem = sharedArray<f32, 256>();",
        "  smem[tid] = xs[tid];",
        "  syncthreads();",
        "",
        "  // max reduction (assumes n == blockDimX() == 256 in this v0 example)",
        "  for (let stride = blockDimX() / (2 as u32); stride > (0 as u32); stride = stride / (2 as u32)) {",
        "    if (tid < stride) {",
        "      const other = smem[tid + stride];",
        "      if (other > smem[tid]) {",
        "        smem[tid] = other;",
        "      }",
        "    }",
        "    syncthreads();",
        "  }",
        "",
        "  const maxVal = smem[0 as u32];",
        "  smem[tid] = expf(smem[tid] - maxVal);",
        "  syncthreads();",
        "",
        "  // sum reduction",
        "  for (let stride = blockDimX() / (2 as u32); stride > (0 as u32); stride = stride / (2 as u32)) {",
        "    if (tid < stride) {",
        "      smem[tid] = smem[tid] + smem[tid + stride];",
        "    }",
        "    syncthreads();",
        "  }",
        "",
        "  const denom = smem[0 as u32];",
        "  out[tid] = smem[tid] / denom;",
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
    expect(out.kernels[0]!.cuSource).to.contain("__shared__ float __tsuba_smem0[256];");
    expect(out.kernels[0]!.cuSource).to.contain("expf(");
    expect(out.kernels[0]!.cuSource).to.contain("__syncthreads();");
    expect(out.kernels[0]!.cuSource).to.contain("for (uint32_t stride = (");
  });

  it("lowers MoE dispatch building-block kernels (v0, compile-only)", () => {
    const dir = makeRepoTempDir("compiler-kernel-moe-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        'import { kernel, threadIdxX, blockIdxX, blockDimX, atomicAdd, addr } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const countExperts = kernel({ name: "countExperts" } as const, (expertIds: global_ptr<u32>, counts: global_ptr<u32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    const e = expertIds[i];",
        "    atomicAdd(addr(counts, e), 1 as u32);",
        "  }",
        "});",
        "",
        'const permuteByExpert = kernel({ name: "permuteByExpert" } as const, (src: global_ptr<u32>, dst: global_ptr<u32>, expertIds: global_ptr<u32>, offsets: global_ptr<u32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    const e = expertIds[i];",
        "    const pos = atomicAdd(addr(offsets, e), 1 as u32);",
        "    dst[pos] = src[i];",
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
    expect(out.kernels).to.have.length(2);
    const count = out.kernels.find((k) => k.name === "countExperts");
    const permute = out.kernels.find((k) => k.name === "permuteByExpert");
    expect(count?.cuSource).to.contain("atomicAdd(");
    expect(count?.cuSource).to.contain("counts");
    expect(permute?.cuSource).to.contain("atomicAdd(");
    expect(permute?.cuSource).to.contain("offsets");
    expect(permute?.cuSource).to.contain("dst[pos] = src[i]");
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

  it("lowers kernel launches to runtime calls and erases kernel imports (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-launch-");
    const kernelFile = join(dir, "add.ts");
    const entry = join(dir, "main.ts");

    writeFileSync(
      kernelFile,
      [
        'import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        "",
        'export const add = kernel({ name: "add" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
        "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
        "  if (i < n) {",
        "    out[i] = a[i] + b[i];",
        "  }",
        "});",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      entry,
      [
        'import { deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { f32, u32 } from "@tsuba/core/types.js";',
        'import { add as addKernel } from "./add.js";',
        "",
        "export function main(): void {",
        "  const n = 1024 as u32;",
        "  const a = deviceMalloc<f32>(n);",
        "  addKernel.launch({ grid: [1, 1, 1], block: [256, 1, 1] } as const, a, a, a, n);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("__tsuba_cuda::device_malloc::<f32>(n)");
    expect(out.mainRs).to.contain("__tsuba_cuda::launch_add(1, 1, 1, 256, 1, 1");
    expect(out.mainRs).to.contain("mod __tsuba_cuda {");
    expect(out.mainRs).to.not.contain("use crate::add::add");
  });

  it("uses kernel spec.name (not the TS variable name) as the emitted CUDA kernel identity (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-name-");
    const kernelFile = join(dir, "k.ts");
    const entry = join(dir, "main.ts");

    writeFileSync(
      kernelFile,
      [
        'import { kernel, threadIdxX } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'export const foo = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  out[threadIdxX()] = 1 as u32;",
        "});",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      entry,
      [
        'import type { u32 } from "@tsuba/core/types.js";',
        'import { deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import { foo } from "./k.js";',
        "",
        "export function main(): void {",
        "  const out = deviceMalloc<u32>(4 as u32);",
        "  foo.launch({ grid: [1, 1, 1], block: [256, 1, 1] } as const, out);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.kernels.map((k) => k.name)).to.deep.equal(["k"]);
    expect(out.mainRs).to.contain("__tsuba_cuda::launch_k(1, 1, 1, 256, 1, 1");
    expect(out.mainRs).to.not.contain("__tsuba_cuda::launch_foo");
  });

  it("errors when kernel values are used as normal host values (v0)", () => {
    const dir = makeRepoTempDir("compiler-kernel-value-");
    const kernelFile = join(dir, "k.ts");
    const entry = join(dir, "main.ts");

    writeFileSync(
      kernelFile,
      [
        'import { kernel } from "@tsuba/gpu/lang.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'export const k = kernel({ name: "k" } as const, (n: u32): void => {',
        "  if (n < n) {",
        "    return;",
        "  }",
        "});",
        "",
      ].join("\n"),
      "utf-8"
    );

    writeFileSync(
      entry,
      [
        'import { k } from "./k.js";',
        "",
        "export function main(): void {",
        "  void k;",
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
    expect((err as CompileError).code).to.equal("TSB1406");
  });

  it("errors on host calls to kernel-only intrinsics (v0)", () => {
    const dir = makeRepoTempDir("compiler-host-gpu-intrinsic-");
    const entry = join(dir, "main.ts");

    writeFileSync(
      entry,
      [
        'import { threadIdxX } from "@tsuba/gpu/lang.js";',
        "",
        "export function main(): void {",
        "  const x = threadIdxX();",
        "  void x;",
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
    expect((err as CompileError).code).to.equal("TSB1476");
  });

  it("lowers device/memcpy markers to runtime calls with borrow insertion (v0)", () => {
    const dir = makeRepoTempDir("compiler-gpu-memcpy-");
    const entry = join(dir, "main.ts");

    writeFileSync(
      entry,
      [
        'import { deviceMalloc, deviceFree, memcpyHtoD, memcpyDtoH } from "@tsuba/gpu/lang.js";',
        'import { Vec } from "@tsuba/std/prelude.js";',
        'import type { f32, u32, mut } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const n = 4 as u32;",
        "  let host: mut<Vec<f32>> = Vec.new<f32>();",
        "  const ptr = deviceMalloc<f32>(n);",
        "  memcpyHtoD(ptr, host);",
        "  memcpyDtoH(host, ptr);",
        "  deviceFree(ptr);",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const out = compileHostToRust({ entryFile: entry });
    expect(out.mainRs).to.contain("__tsuba_cuda::device_malloc::<f32>(n)");
    expect(out.mainRs).to.contain("__tsuba_cuda::memcpy_htod(ptr, &(host))");
    expect(out.mainRs).to.contain("__tsuba_cuda::memcpy_dtoh(&mut (host), ptr)");
    expect(out.mainRs).to.contain("__tsuba_cuda::device_free(ptr)");
    expect(out.mainRs).to.contain("mod __tsuba_cuda {");
  });
});
