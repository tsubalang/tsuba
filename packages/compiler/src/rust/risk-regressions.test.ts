import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CompileError, compileHostToRust } from "./host.js";

describe("@tsuba/compiler risk regressions", () => {
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

  function compileEntry(source: string): string {
    const dir = makeRepoTempDir("compiler-risk-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source, "utf-8");
    const out = compileHostToRust({ entryFile: entry });
    return out.mainRs;
  }

  function expectCompileError(source: string): CompileError {
    const dir = makeRepoTempDir("compiler-risk-err-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, source, "utf-8");
    try {
      compileHostToRust({ entryFile: entry });
      throw new Error("Expected compile error.");
    } catch (error) {
      expect(error).to.be.instanceOf(CompileError);
      return error as CompileError;
    }
  }

  it("inserts mutable borrows for mutref function parameters", () => {
    const rust = compileEntry(
      [
        'import type { i32, mut, mutref } from "@tsuba/core/types.js";',
        "",
        "function tick(x: mutref<i32>): void {",
        "  void x;",
        "}",
        "",
        "export function main(): void {",
        "  let v: mut<i32> = 1 as i32;",
        "  tick(v);",
        "}",
        "",
      ].join("\n")
    );

    expect(rust).to.contain("tick(&mut (v));");
  });

  it("inserts immutable borrows for ref function parameters", () => {
    const rust = compileEntry(
      [
        'import type { i32, ref } from "@tsuba/core/types.js";',
        "",
        "function read(x: ref<i32>): i32 {",
        "  return x;",
        "}",
        "",
        "export function main(): void {",
        "  const v = 1 as i32;",
        "  const y = read(v);",
        "  void y;",
        "}",
        "",
      ].join("\n")
    );

    expect(rust).to.contain("let y = read(&(v));");
  });

  it("uses contextual nominal object literal lowering instead of synthesized anon structs", () => {
    const rust = compileEntry(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Pair = {",
        "  left: i32;",
        "  right: i32;",
        "};",
        "",
        "function sum(p: Pair): i32 {",
        "  return (p.left + p.right) as i32;",
        "}",
        "",
        "export function main(): void {",
        "  const x = sum({ left: 5 as i32, right: 7 as i32 });",
        "  void x;",
        "}",
        "",
      ].join("\n")
    );

    expect(rust).to.contain("sum(Pair { left: (5) as i32, right: (7) as i32 })");
    expect(rust).to.not.contain("__Anon_");
  });

  it("synthesizes separate anon structs for uncontextual object literals by construction span", () => {
    const rust = compileEntry(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const a = { x: 1 as i32, y: 2 as i32 };",
        "  const b = { x: 3 as i32, y: 4 as i32 };",
        "  void a;",
        "  void b;",
        "}",
        "",
      ].join("\n")
    );

    const names = [...rust.matchAll(/struct (__Anon_[0-9a-f]{8})/g)].map((m) => m[1]!);
    expect(names.length).to.equal(2);
    expect(new Set(names).size).to.equal(2);
  });

  it("rejects duplicate discriminated-union switch cases", () => {
    const err = expectCompileError(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Shape =",
        '  | { kind: "circle"; radius: i32 }',
        '  | { kind: "square"; side: i32 };',
        "",
        "function bad(s: Shape): void {",
        "  switch (s.kind) {",
        '    case "circle":',
        "      return;",
        '    case "circle":',
        "      return;",
        '    case "square":',
        "      return;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  void bad;",
        "}",
        "",
      ].join("\n")
    );

    expect(err.code).to.equal("TSB2205");
  });

  it("always emits move closures when using move(...)", () => {
    const rust = compileEntry(
      [
        'import { move } from "@tsuba/core/lang.js";',
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const f = move((x: i32): i32 => (x + (1 as i32)) as i32);",
        "  void f;",
        "}",
        "",
      ].join("\n")
    );

    expect(rust).to.contain("let f = move |x: i32|");
  });

  it("rejects block-bodied closures with stable diagnostics", () => {
    const err = expectCompileError(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const f = (x: i32): i32 => {",
        "    return x;",
        "  };",
        "  void f;",
        "}",
        "",
      ].join("\n")
    );

    expect(err.code).to.equal("TSB1100");
  });

  it("supports nested lexical blocks with shadowing semantics", () => {
    const rust = compileEntry(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const x = 1 as i32;",
        "  {",
        "    const x = 2 as i32;",
        "    void x;",
        "  }",
        "  void x;",
        "}",
        "",
      ].join("\n")
    );

    expect(rust).to.contain("let x = (1) as i32;");
    expect(rust).to.contain("let x = (2) as i32;");
  });

  it("rejects uncontextual object literals without explicit field type assertions", () => {
    const err = expectCompileError(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const value = { x: 1, y: 2 as i32 };",
        "  void value;",
        "}",
        "",
      ].join("\n")
    );

    expect(err.code).to.equal("TSB1131");
  });

  it("fails fast at TypeScript layer for excess contextual object literal fields", () => {
    const err = expectCompileError(
      [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Pair = {",
        "  left: i32;",
        "  right: i32;",
        "};",
        "",
        "function sum(pair: Pair): i32 {",
        "  return (pair.left + pair.right) as i32;",
        "}",
        "",
        "export function main(): void {",
        "  const value = sum({ left: 1 as i32, right: 2 as i32, extra: 3 as i32 });",
        "  void value;",
        "}",
        "",
      ].join("\n")
    );

    expect(err.code).to.equal("TSB0002");
  });

  it("is byte-deterministic for repeated compiles with identical source and config", () => {
    const dir = makeRepoTempDir("compiler-risk-deterministic-");
    const entry = join(dir, "main.ts");
    const source = [
      'import type { i32 } from "@tsuba/core/types.js";',
      "",
      "function add(a: i32, b: i32): i32 {",
      "  return (a + b) as i32;",
      "}",
      "",
      "export function main(): void {",
      "  const value = add(3 as i32, 4 as i32);",
      "  if (value === (7 as i32)) {",
      "    void value;",
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(entry, source, "utf-8");

    const a = compileHostToRust({ entryFile: entry });
    const b = compileHostToRust({ entryFile: entry });
    expect(b.mainRs).to.equal(a.mainRs);
    expect(b.crates).to.deep.equal(a.crates);
    expect(b.kernels).to.deep.equal(a.kernels);
  });

  it("is byte-deterministic across relocated project roots", () => {
    const source = [
      'import type { i32 } from "@tsuba/core/types.js";',
      "",
      "type Pair = {",
      "  left: i32;",
      "  right: i32;",
      "};",
      "",
      "function sum(p: Pair): i32 {",
      "  return (p.left + p.right) as i32;",
      "}",
      "",
      "export function main(): void {",
      "  const p = { left: 1 as i32, right: 2 as i32 };",
      "  const out = sum(p);",
      "  void out;",
      "}",
      "",
    ].join("\n");

    const dirA = makeRepoTempDir("compiler-risk-reloc-a-");
    const dirB = makeRepoTempDir("compiler-risk-reloc-b-");
    const entryA = join(dirA, "main.ts");
    const entryB = join(dirB, "main.ts");
    writeFileSync(entryA, source, "utf-8");
    writeFileSync(entryB, source, "utf-8");

    const outA = compileHostToRust({ entryFile: entryA });
    const outB = compileHostToRust({ entryFile: entryB });

    expect(outA.mainRs).to.equal(outB.mainRs);
    expect(outA.mainRs).to.contain("// tsuba-span: main.ts:");
    expect(outA.mainRs).to.not.contain(dirA.replaceAll("\\", "/"));
    expect(outB.mainRs).to.not.contain(dirB.replaceAll("\\", "/"));
    expect(outA.crates).to.deep.equal(outB.crates);
    expect(outA.kernels).to.deep.equal(outB.kernels);
  });

  it("keeps kernel lowering deterministic across relocated project roots", () => {
    const source = [
      'import type { f32, u32 } from "@tsuba/core/types.js";',
      'import type { global_ptr } from "@tsuba/gpu/types.js";',
      'import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";',
      "",
      'const add = kernel({ name: "add_kernel" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
      "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
      "  if (i < n) {",
      "    out[i] = a[i] + b[i];",
      "  }",
      "});",
      "",
      "export function main(): void {",
      "  return;",
      "}",
      "",
    ].join("\n");

    const dirA = makeRepoTempDir("compiler-risk-kernel-reloc-a-");
    const dirB = makeRepoTempDir("compiler-risk-kernel-reloc-b-");
    const entryA = join(dirA, "main.ts");
    const entryB = join(dirB, "main.ts");
    writeFileSync(entryA, source, "utf-8");
    writeFileSync(entryB, source, "utf-8");

    const outA = compileHostToRust({ entryFile: entryA });
    const outB = compileHostToRust({ entryFile: entryB });

    expect(outA.mainRs).to.equal(outB.mainRs);
    expect(outA.kernels).to.deep.equal(outB.kernels);
    expect(outA.kernels).to.have.length(1);
    expect(outA.kernels[0]!.name).to.equal("add_kernel");
  });
});
