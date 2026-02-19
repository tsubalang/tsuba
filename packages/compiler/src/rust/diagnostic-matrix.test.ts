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
      compileHostToRust({ entryFile: entry });
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
