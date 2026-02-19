import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compilerDiagnosticDomain, isCompilerDiagnosticCode } from "./diagnostics.js";
import { CompileError, compileHostToRust } from "./host.js";

type CaseDef = {
  readonly name: string;
  readonly expectedCode: string;
  readonly expectedDomain:
    | "entry-and-expressions"
    | "control-flow"
    | "functions-imports-and-annotations"
    | "classes-and-methods"
    | "types-and-traits";
  readonly entrySource: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly runtimeKind?: "none" | "tokio";
};

describe("@tsuba/compiler diagnostics matrix", () => {
  function makeRepoTempDir(prefix: string): string {
    const here = fileURLToPath(import.meta.url);
    const repoRoot = resolve(dirname(here), "../../../..");
    const base = join(repoRoot, ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function expectCompileError(def: CaseDef): CompileError {
    const dir = makeRepoTempDir("compiler-diag-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, def.entrySource, "utf-8");
    for (const [rel, source] of Object.entries(def.extraFiles ?? {})) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source, "utf-8");
    }
    try {
      compileHostToRust({ entryFile: entry, runtimeKind: def.runtimeKind });
      throw new Error(`Expected compile failure for case: ${def.name}`);
    } catch (error) {
      expect(error).to.be.instanceOf(CompileError);
      return error as CompileError;
    }
  }

  const cases: readonly CaseDef[] = [
    {
      name: "entry contract requires exported main",
      expectedCode: "TSB1000",
      expectedDomain: "entry-and-expressions",
      entrySource: ["export function notMain(): void {", "  return;", "}", ""].join("\n"),
    },
    {
      name: "control-flow requires initialized local variables",
      expectedCode: "TSB2002",
      expectedDomain: "control-flow",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  let value: i32;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "import surface rejects side-effect imports",
      expectedCode: "TSB3206",
      expectedDomain: "functions-imports-and-annotations",
      entrySource: [
        'import "./dep.js";',
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "dep.ts": "export {};\n",
      },
    },
    {
      name: "class fields require explicit type annotations",
      expectedCode: "TSB4013",
      expectedDomain: "classes-and-methods",
      entrySource: [
        "class User {",
        '  email = "";',
        "}",
        "",
        "export function main(): void {",
        "  void User;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "traits reject optional method members",
      expectedCode: "TSB5104",
      expectedDomain: "types-and-traits",
      entrySource: [
        'import type { i32, ref } from "@tsuba/core/types.js";',
        "",
        "interface Reader {",
        "  read?(this: ref<this>): i32;",
        "}",
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions reject Promise.then chains",
      expectedCode: "TSB1306",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        "declare function f(): Promise<void>;",
        "",
        "export function main(): void {",
        "  f().then(() => {});",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions reject move(...) with non-arrow callbacks",
      expectedCode: "TSB1303",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import { move } from "@tsuba/core/lang.js";',
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "function inc(x: i32): i32 {",
        "  return (x + (1 as i32)) as i32;",
        "}",
        "",
        "export function main(): void {",
        "  const bad = move(inc);",
        "  void bad;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions reject block-bodied closure literals",
      expectedCode: "TSB1100",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  const f = (x: i32): i32 => {",
        "    return x;",
        "  };",
        "  void f;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions reject await outside async functions",
      expectedCode: "TSB1308",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        "declare function f(): Promise<void>;",
        "",
        "export function main(): void {",
        "  // @ts-ignore -- intentionally validated by Tsuba diagnostics",
        "  await f();",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions require place expressions for &mut borrows",
      expectedCode: "TSB1310",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import type { i32, mut, mutref } from "@tsuba/core/types.js";',
        "",
        "function update(x: mutref<i32>): void {",
        "  void x;",
        "}",
        "",
        "export function main(): void {",
        "  let v: mut<i32> = 1 as i32;",
        "  update(v + (1 as i32));",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry contract rejects async main without tokio runtime policy",
      expectedCode: "TSB1004",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        "export async function main(): Promise<void> {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      runtimeKind: "none",
    },
    {
      name: "entry contract rejects async main returning non-void promise payload",
      expectedCode: "TSB1003",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export async function main(): Promise<i32> {",
        "  return 1 as i32;",
        "}",
        "",
      ].join("\n"),
      runtimeKind: "tokio",
    },
    {
      name: "control-flow rejects union switch default clauses",
      expectedCode: "TSB2203",
      expectedDomain: "control-flow",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Shape =",
        '  | { kind: "circle"; r: i32 }',
        '  | { kind: "square"; side: i32 };',
        "",
        "function area(s: Shape): i32 {",
        "  switch (s.kind) {",
        '    case "circle":',
        "      return s.r;",
        "    default:",
        "      return 0 as i32;",
        "    case \"square\":",
        "      return s.side;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "control-flow enforces exhaustive union switches",
      expectedCode: "TSB2210",
      expectedDomain: "control-flow",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Shape =",
        '  | { kind: "circle"; r: i32 }',
        '  | { kind: "square"; side: i32 };',
        "",
        "function area(s: Shape): void {",
        "  switch (s.kind) {",
        '    case "circle":',
        "      void s.r;",
        "      break;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "control-flow rejects for-loop var declarations",
      expectedCode: "TSB2120",
      expectedDomain: "control-flow",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "export function main(): void {",
        "  for (var i: i32 = 0 as i32; i < (2 as i32); i++) {",
        "    void i;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "control-flow restricts switch discriminants to union-tag property access",
      expectedCode: "TSB2200",
      expectedDomain: "control-flow",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Shape =",
        '  | { kind: "circle"; r: i32 }',
        '  | { kind: "square"; side: i32 };',
        "",
        "function area(s: Shape): void {",
        "  switch ((s as unknown as { kind: string }).kind) {",
        '    case "circle":',
          "      return;",
        '    case "square":',
          "      return;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "import surface enforces bindings manifest modules mapping",
      expectedCode: "TSB3225",
      expectedDomain: "functions-imports-and-annotations",
      entrySource: [
        'import { Foo } from "@tsuba/bad/index.js";',
        "",
        "export function main(): void {",
        "  void Foo;",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "node_modules/@tsuba/bad/package.json": '{"name":"@tsuba/bad","version":"0.0.1"}\n',
        "node_modules/@tsuba/bad/index.js": "export {};\n",
        "node_modules/@tsuba/bad/index.d.ts": "export declare class Foo {}\n",
        "node_modules/@tsuba/bad/tsuba.bindings.json":
          JSON.stringify(
            {
              schema: 1,
              kind: "crate",
              crate: { name: "bad", package: "bad", version: "0.0.1" },
            },
            null,
            2
          ) + "\n",
      },
    },
    {
      name: "import surface rejects bindings crate source conflicts",
      expectedCode: "TSB3228",
      expectedDomain: "functions-imports-and-annotations",
      entrySource: [
        'import { Foo } from "@tsuba/bad/index.js";',
        "",
        "export function main(): void {",
        "  void Foo;",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "node_modules/@tsuba/bad/package.json": '{"name":"@tsuba/bad","version":"0.0.1"}\n',
        "node_modules/@tsuba/bad/index.js": "export {};\n",
        "node_modules/@tsuba/bad/index.d.ts": "export declare class Foo {}\n",
        "node_modules/@tsuba/bad/tsuba.bindings.json":
          JSON.stringify(
            {
              schema: 1,
              kind: "crate",
              crate: { name: "bad", package: "bad", version: "0.0.1", path: "./crate" },
              modules: { "@tsuba/bad/index.js": "bad" },
            },
            null,
            2
          ) + "\n",
      },
    },
    {
      name: "annotation markers require declaration-before-annotate ordering",
      expectedCode: "TSB3311",
      expectedDomain: "functions-imports-and-annotations",
      entrySource: [
        'import { annotate, attr, tokens } from "@tsuba/core/lang.js";',
        "",
        'annotate(main, attr("inline", tokens`always`));',
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "annotation markers require known annotate targets",
      expectedCode: "TSB3310",
      expectedDomain: "functions-imports-and-annotations",
      entrySource: [
        'import { annotate, attr, tokens } from "@tsuba/core/lang.js";',
        'import { helper } from "./dep.js";',
        "",
        'annotate(helper, attr("inline", tokens`always`));',
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "dep.ts": [
          "export function helper(): void {",
          "  return;",
          "}",
          "",
        ].join("\n"),
      },
    },
    {
      name: "entry expressions validate kernel launch config shape",
      expectedCode: "TSB1473",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import { kernel, deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  out[0 as u32] = 1 as u32;",
        "});",
        "",
        "export function main(): void {",
        "  const out = deviceMalloc<u32>(1 as u32);",
        "  k.launch(({ grid: [1 as u32, 1 as u32, 1 as u32] } as unknown as import(\"@tsuba/gpu/lang.js\").LaunchConfig), out);",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions require object-literal kernel launch config",
      expectedCode: "TSB1471",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import { kernel, deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  out[0 as u32] = 1 as u32;",
        "});",
        "",
        "export function main(): void {",
        "  const out = deviceMalloc<u32>(1 as u32);",
        "  k.launch((3 as unknown as import(\"@tsuba/gpu/lang.js\").LaunchConfig), out);",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions require 3D grid and block launch dimensions",
      expectedCode: "TSB1472",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import { kernel, deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  out[0 as u32] = 1 as u32;",
        "});",
        "",
        "export function main(): void {",
        "  const out = deviceMalloc<u32>(1 as u32);",
        "  k.launch(({ grid: [1 as u32, 1 as u32], block: [1 as u32, 1 as u32, 1 as u32] } as unknown as import(\"@tsuba/gpu/lang.js\").LaunchConfig), out);",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "entry expressions reject unknown kernel launch config properties",
      expectedCode: "TSB1473",
      expectedDomain: "entry-and-expressions",
      entrySource: [
        'import { kernel, deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { global_ptr } from "@tsuba/gpu/types.js";',
        'import type { u32 } from "@tsuba/core/types.js";',
        "",
        'const k = kernel({ name: "k" } as const, (out: global_ptr<u32>): void => {',
        "  out[0 as u32] = 1 as u32;",
        "});",
        "",
        "export function main(): void {",
        "  const out = deviceMalloc<u32>(1 as u32);",
        "  k.launch(({ grid: [1 as u32, 1 as u32, 1 as u32], block: [1 as u32, 1 as u32, 1 as u32], stream: 0 as u32 } as unknown as import(\"@tsuba/gpu/lang.js\").LaunchConfig), out);",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "class fields must be initialized by declaration or constructor",
      expectedCode: "TSB4029",
      expectedDomain: "classes-and-methods",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "class User {",
        "  id!: i32;",
        "  constructor() {}",
        "}",
        "",
        "export function main(): void {",
        "  void User;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "union variants reject optional fields",
      expectedCode: "TSB5009",
      expectedDomain: "types-and-traits",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Result =",
        '  | { kind: "ok"; value?: i32 }',
        '  | { kind: "err"; code: i32 };',
        "",
        "export function main(): void {",
        "  void 0;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "interfaces require the first method parameter to be a this receiver",
      expectedCode: "TSB5106",
      expectedDomain: "types-and-traits",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "interface Reader {",
        "  read(value: i32): i32;",
        "}",
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "object type aliases reject optional fields",
      expectedCode: "TSB5203",
      expectedDomain: "types-and-traits",
      entrySource: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "",
        "type Point = {",
        "  x?: i32;",
        "};",
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  for (const def of cases) {
    it(def.name, () => {
      const err = expectCompileError(def);
      expect(err.code).to.equal(def.expectedCode);
      expect(isCompilerDiagnosticCode(err.code)).to.equal(true);
      if (!isCompilerDiagnosticCode(err.code)) {
        throw new Error(`Expected compiler diagnostic code, got ${err.code}`);
      }
      expect(compilerDiagnosticDomain(err.code)).to.equal(def.expectedDomain);
    });
  }
});
