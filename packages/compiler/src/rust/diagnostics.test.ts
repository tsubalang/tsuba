import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const source = readFileSync(hostPath, "utf-8");
    const matches = source.match(/\bTSB\d{4}\b/g) ?? [];
    return [...new Set(matches)].sort((a, b) => a.localeCompare(b));
  }

  it("keeps compiler diagnostic codes normalized and unique", () => {
    const values = [...COMPILER_DIAGNOSTIC_CODES];
    const unique = new Set(values);
    expect(unique.size).to.equal(values.length);
    for (const code of values) {
      expect(code).to.match(/^TSB\d{4}$/);
    }
  });

  it("keeps host.ts diagnostic usage synchronized with the registry", () => {
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
});
