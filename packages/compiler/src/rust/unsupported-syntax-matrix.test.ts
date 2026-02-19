import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CompileError, compileHostToRust } from "./host.js";

type UnsupportedCase = {
  readonly name: string;
  readonly expectedCode: string;
  readonly source: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
};

describe("@tsuba/compiler unsupported syntax matrix", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function expectCompileError(def: UnsupportedCase): CompileError {
    const dir = makeRepoTempDir("compiler-unsupported-matrix-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, def.source, "utf-8");
    for (const [rel, content] of Object.entries(def.extraFiles ?? {})) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }
    try {
      compileHostToRust({ entryFile: entry, runtimeKind: "tokio" });
      throw new Error(`Expected compile failure for case: ${def.name}`);
    } catch (error) {
      expect(error).to.be.instanceOf(CompileError);
      return error as CompileError;
    }
  }

  const cases: readonly UnsupportedCase[] = [
    {
      name: "default import is rejected",
      expectedCode: "TSB3207",
      source: ['import dep from "./dep.js";', "export function main(): void {", "  void dep;", "}", ""].join("\n"),
      extraFiles: { "dep.ts": "export default function dep(): void {\n  return;\n}\n" },
    },
    {
      name: "namespace imports are rejected",
      expectedCode: "TSB3209",
      source: ['import * as dep from "./dep.js";', "export function main(): void {", "  void dep;", "}", ""].join("\n"),
      extraFiles: { "dep.ts": "export function dep(): void {\n  return;\n}\n" },
    },
    {
      name: "side-effect imports are rejected",
      expectedCode: "TSB3206",
      source: ['import "./dep.js";', "export function main(): void {", "  return;", "}", ""].join("\n"),
      extraFiles: { "dep.ts": "export function dep(): void {\n  return;\n}\n" },
    },
    {
      name: "unknown packages are rejected",
      expectedCode: "TSB3211",
      source: [
        "// @ts-ignore -- intentionally validated by Tsuba diagnostics",
        'import { x } from "@tsuba/not-a-real-package/index.js";',
        "export function main(): void {",
        "  void x;",
        "}",
        "",
      ].join(
        "\n"
      ),
    },
    {
      name: "barrel re-exports are rejected",
      expectedCode: "TSB3214",
      source: [
        'export { a } from "./dep.js";',
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      extraFiles: { "dep.ts": "export function a(): void {\n  return;\n}\n" },
    },
    {
      name: "generic arrow functions are rejected",
      expectedCode: "TSB1100",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "export function main(): void {", "  const id = <T,>(x: T): T => x;", "  const x = id(1 as i32);", "  void x;", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "block arrow closures reject non-terminal return statements",
      expectedCode: "TSB1100",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "export function main(): void {",
        "  const f = (x: i32): i32 => {",
        "    return x;",
        "    const y = (x + (1 as i32)) as i32;",
        "    return y;",
        "  };",
        "  void f;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "function destructuring params are rejected",
      expectedCode: "TSB3002",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "function f({ x }: { x: i32 }): i32 {", "  return x;", "}", "export function main(): void {", "  void f;", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "function params require type annotations",
      expectedCode: "TSB3003",
      source: [
        "// @ts-ignore -- intentionally validated by Tsuba diagnostics",
        "function f(x): void {",
        "  void x;",
        "}",
        "export function main(): void {",
        "  void f;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "function optional params are rejected",
      expectedCode: "TSB3004",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "function f(x?: i32): void {", "  void x;", "}", "export function main(): void {", "  void f;", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "any type annotations are rejected",
      expectedCode: "TSB1010",
      source: [
        "function f(x: any): void {",
        "  void x;",
        "}",
        "export function main(): void {",
        "  void f;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "conditional type aliases are rejected",
      expectedCode: "TSB5206",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "type Lift<T> = T extends i32 ? i32 : i32;",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "mapped type aliases are rejected",
      expectedCode: "TSB5206",
      source: [
        "type Copy<T> = { [P in keyof T]: T[P] };",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "infer-based type aliases are rejected",
      expectedCode: "TSB5206",
      source: [
        "type Lift<T> = T extends infer R ? R : never;",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "intersection type aliases are rejected",
      expectedCode: "TSB5206",
      source: [
        "type Pair = { a: number } & { b: number };",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "type alias generic defaults are rejected",
      expectedCode: "TSB5205",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "type Box<T = i32> = T;",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "class extends is rejected",
      expectedCode: "TSB4002",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "class Base {",
        "  value: i32 = 0 as i32;",
        "}",
        "class Derived extends Base {",
        "  id: i32 = 1 as i32;",
        "}",
        "export function main(): void {",
        "  void Derived;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "constructor optional params are rejected",
      expectedCode: "TSB4024",
      source: [
        'import type { String } from \"@tsuba/core/types.js\";',
        "class User {",
        "  name: String = \"\";",
        "  constructor(name?: String) {",
        "    this.name = name as String;",
        "  }",
        "}",
        "export function main(): void {",
        "  void User;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "constructor default params are rejected",
      expectedCode: "TSB4024",
      source: [
        'import type { String } from \"@tsuba/core/types.js\";',
        "class User {",
        "  name: String = \"\";",
        "  constructor(name: String = \"x\") {",
        "    this.name = name;",
        "  }",
        "}",
        "export function main(): void {",
        "  void User;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "static methods are rejected",
      expectedCode: "TSB4100",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "class Counter {",
        "  value: i32 = 0 as i32;",
        "  static make(): Counter {",
        "    return new Counter();",
        "  }",
        "}",
        "export function main(): void {",
        "  void Counter;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "method this param type must be ref/mutref",
      expectedCode: "TSB4105",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "class Counter {",
        "  value: i32 = 0 as i32;",
        "  read(this: i32): i32 {",
        "    return this;",
        "  }",
        "}",
        "export function main(): void {",
        "  void Counter;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "method optional params are rejected",
      expectedCode: "TSB4107",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "class Counter {",
        "  value: i32 = 0 as i32;",
        "  read(delta?: i32): i32 {",
        "    void delta;",
        "    return this.value;",
        "  }",
        "}",
        "export function main(): void {",
        "  void Counter;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "interface method optional params are rejected",
      expectedCode: "TSB5109",
      source: [
        'import type { i32, ref } from \"@tsuba/core/types.js\";',
        "interface Reader {",
        "  read(this: ref<this>, delta?: i32): i32;",
        "}",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "object spread is rejected",
      expectedCode: "TSB1118",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "export function main(): void {", "  const x = { a: 1 as i32 };", "  const y = { ...x, b: 2 as i32 };", "  void y;", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "optional chaining is rejected",
      expectedCode: "TSB1114",
      source: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "class Box {",
        "  value: i32 = 1 as i32;",
        "}",
        "function make(): Box {",
        "  return new Box();",
        "}",
        "export function main(): void {",
        "  const v = make()?.value;",
        "  void v;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "array spread is rejected",
      expectedCode: "TSB1111",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "export function main(): void {", "  const x = [1 as i32];", "  const y = [...x, 2 as i32];", "  void y;", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "nullish coalescing is rejected",
      expectedCode: "TSB1201",
      source: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "declare const maybe: unknown;",
        "export function main(): void {",
        "  const v = maybe ?? (2 as i32);",
        "  void v;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "Promise.then chains are rejected",
      expectedCode: "TSB1306",
      source: ["declare function f(): Promise<void>;", "export function main(): void {", "  f().then(() => {});", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "await outside async is rejected",
      expectedCode: "TSB1308",
      source: [
        "declare function f(): Promise<void>;",
        "export function main(): void {",
        "  // @ts-ignore -- intentionally validated by Tsuba diagnostics",
        "  await f();",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "union switch default clauses are rejected",
      expectedCode: "TSB2203",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "type Shape =",
        '  | { kind: "circle"; radius: i32 }',
        '  | { kind: "square"; side: i32 };',
        "function area(s: Shape): i32 {",
        "  switch (s.kind) {",
        '    case "circle":',
        "      return s.radius;",
        "    default:",
        "      return 0 as i32;",
        '    case "square":',
        "      return s.side;",
        "  }",
        "}",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "union switch case expressions must be string literals",
      expectedCode: "TSB2204",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "type Shape =",
        '  | { kind: "circle"; radius: i32 }',
        '  | { kind: "square"; side: i32 };',
        "function area(s: Shape): i32 {",
        '  const circle = "circle";',
        "  switch (s.kind) {",
        "    case circle:",
        "      return s.radius;",
        '    case "square":',
        "      return s.side;",
        "  }",
        "}",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "union switch empty case fallthrough is rejected",
      expectedCode: "TSB2207",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "type Shape =",
        '  | { kind: "circle"; radius: i32 }',
        '  | { kind: "square"; side: i32 };',
        "function area(s: Shape): i32 {",
        "  switch (s.kind) {",
        '    case "circle":',
        '    case "square":',
        "      return 0 as i32;",
        "  }",
        "}",
        "export function main(): void {",
        "  void area;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "non-union switch duplicate case labels are rejected",
      expectedCode: "TSB2212",
      source: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "function classify(x: i32): i32 {",
        "  switch (x) {",
        "    case 1:",
        "      return 1 as i32;",
        "    case 1:",
        "      return 2 as i32;",
        "    default:",
        "      return 0 as i32;",
        "  }",
        "}",
        "export function main(): void {",
        "  void classify;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "for-loop var declarations are rejected",
      expectedCode: "TSB2120",
      source: ['import type { i32 } from \"@tsuba/core/types.js\";', "export function main(): void {", "  for (var i = 0 as i32; i < (10 as i32); i++) {", "    void i;", "  }", "}", ""].join(
        "\n"
      ),
    },
    {
      name: "for-of statements are rejected in v0",
      expectedCode: "TSB2100",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "export function main(): void {",
        "  for (const value of [1 as i32, 2 as i32]) {",
        "    void value;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "top-level non-const variables are rejected",
      expectedCode: "TSB3100",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "let seed: i32 = 1 as i32;",
        "export function main(): void {",
        "  void seed;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "object literal methods are rejected",
      expectedCode: "TSB1119",
      source: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "export function main(): void {",
        "  const value = {",
        "    read(): i32 {",
        "      return 1 as i32;",
        "    },",
        "  };",
        "  void value;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  for (const c of cases) {
    it(`${c.name} -> ${c.expectedCode}`, () => {
      const err = expectCompileError(c);
      expect(err.code).to.equal(c.expectedCode);
      expect(err.span, `${c.name}: error must include source span`).to.not.equal(undefined);
      expect(err.span?.fileName, `${c.name}: span file should map to fixture source`).to.match(
        /main\.ts$|dep\.ts$/
      );
      expect(err.span?.end, `${c.name}: span end must be >= span start`).to.be.gte(err.span?.start ?? 0);
      expect(err.message.length, `${c.name}: message must be actionable`).to.be.greaterThan(16);
    });
  }
});
