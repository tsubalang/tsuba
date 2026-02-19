import { expect } from "chai";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  assertCompilerDiagnosticCode,
  COMPILER_DIAGNOSTIC_CODES,
  compilerDiagnosticDomain,
} from "./diagnostics.js";

describe("@tsuba/compiler diagnostics registry", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "../../../..");
  }

  function extractHostCodes(): readonly string[] {
    const matches = new Set<string>();
    for (const file of compilerSourceFiles()) {
      const source = readFileSync(file, "utf-8");
      for (const code of source.match(/\bTSB\d{4}\b/g) ?? []) {
        matches.add(code);
      }
    }
    return [...matches].sort((a, b) => a.localeCompare(b));
  }

  function compilerSourceFiles(): readonly string[] {
    const root = join(repoRoot(), "packages", "compiler", "src");
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const abs = join(dir, entry);
        const st = statSync(abs);
        if (st.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!abs.endsWith(".ts")) continue;
        if (abs.endsWith(".test.ts")) continue;
        out.push(abs);
      }
    };
    walk(root);
    return out.sort((a, b) => a.localeCompare(b));
  }

  it("keeps compiler diagnostic codes normalized and unique", () => {
    const values = [...COMPILER_DIAGNOSTIC_CODES];
    const unique = new Set(values);
    expect(unique.size).to.equal(values.length);
    for (const code of values) {
      expect(code).to.match(/^TSB\d{4}$/);
    }
  });

  it("keeps compiler diagnostic usage synchronized with the registry", () => {
    const fromHost = extractHostCodes();
    const fromRegistry = [...COMPILER_DIAGNOSTIC_CODES].sort((a, b) => a.localeCompare(b));
    expect(fromHost).to.deep.equal(fromRegistry);
  });

  it("rejects unknown diagnostic codes", () => {
    expect(() => assertCompilerDiagnosticCode("TSB9999")).to.throw("Unknown compiler diagnostic code");
  });

  it("maps each registered diagnostic code into a known domain", () => {
    for (const code of COMPILER_DIAGNOSTIC_CODES) {
      expect(compilerDiagnosticDomain(code)).to.not.equal("other");
    }
  });

  it("keeps user-facing compiler paths free of raw Error throws", () => {
    const allowList = new Set([join(repoRoot(), "packages", "compiler", "src", "rust", "diagnostics.ts")]);
    const offenders: string[] = [];
    for (const file of compilerSourceFiles()) {
      const src = readFileSync(file, "utf-8");
      if (!src.includes("throw new Error(")) continue;
      if (allowList.has(file)) continue;
      offenders.push(file);
    }
    expect(offenders).to.deep.equal([]);
  });

  it("keeps direct fail(...) calls span-annotated", () => {
    const offenders: string[] = [];
    for (const file of compilerSourceFiles()) {
      const src = readFileSync(file, "utf-8");
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fail") {
          if (node.arguments.length < 3) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            offenders.push(`${file}:${line + 1}:${character + 1}`);
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
    }
    expect(offenders).to.deep.equal([]);
  });
});
