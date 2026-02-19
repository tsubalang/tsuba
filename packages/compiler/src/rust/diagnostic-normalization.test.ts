import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CompileError, compileHostToRust } from "./host.js";

type DiagnosticCase = {
  readonly name: string;
  readonly expectedCode: string;
  readonly expectedMessageFragment: string;
  readonly source: string;
};

describe("@tsuba/compiler diagnostic normalization", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function expectCompileError(def: DiagnosticCase): CompileError {
    const dir = makeRepoTempDir("compiler-diag-normalization-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, def.source, "utf-8");
    try {
      compileHostToRust({ entryFile: entry, runtimeKind: "tokio" });
      throw new Error(`Expected compile failure for case: ${def.name}`);
    } catch (error) {
      expect(error).to.be.instanceOf(CompileError);
      return error as CompileError;
    }
  }

  const cases: readonly DiagnosticCase[] = [
    {
      name: "function optional parameter",
      expectedCode: "TSB3004",
      expectedMessageFragment: "optional params are not supported in v0.",
      source: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "function f(x?: i32): i32 {",
        "  return x as i32;",
        "}",
        "export function main(): void {",
        "  void f;",
        "}",
        "",
      ].join("\n"),
    },
    {
      name: "method optional parameter",
      expectedCode: "TSB4107",
      expectedMessageFragment: "Optional params are not supported in v0.",
      source: [
        'import type { i32 } from "@tsuba/core/types.js";',
        "class Counter {",
        "  value: i32 = 0 as i32;",
        "  read(delta?: i32): i32 {",
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
      name: "interface optional parameter",
      expectedCode: "TSB5109",
      expectedMessageFragment: "optional params are not supported in v0.",
      source: [
        'import type { i32, ref } from "@tsuba/core/types.js";',
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
      name: "constructor default parameter",
      expectedCode: "TSB4024",
      expectedMessageFragment: "Default constructor parameters are not supported in v0.",
      source: [
        'import type { String } from "@tsuba/core/types.js";',
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
  ];

  for (const c of cases) {
    it(`normalizes ${c.name} diagnostics`, () => {
      const err = expectCompileError(c);
      expect(err.code).to.equal(c.expectedCode);
      expect(err.message).to.contain(c.expectedMessageFragment);
      expect(err.span).to.not.equal(undefined);
      expect(err.span?.fileName).to.match(/main\.ts$/);
      expect(err.span?.end).to.be.gte(err.span?.start ?? 0);
    });
  }
});
