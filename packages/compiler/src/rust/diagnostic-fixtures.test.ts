import { expect } from "chai";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertCompilerDiagnosticCode, compilerDiagnosticDomain, isCompilerDiagnosticCode } from "./diagnostics.js";
import { CompileError, compileHostToRust } from "./host.js";

type ExpectedDiagnostic = {
  readonly code: string;
  readonly domain:
    | "entry-and-expressions"
    | "control-flow"
    | "functions-imports-and-annotations"
    | "classes-and-methods"
    | "types-and-traits";
  readonly messageIncludes?: readonly string[];
};

type FixtureCase = {
  readonly id: string;
  readonly domain: string;
  readonly absDir: string;
  readonly expected: ExpectedDiagnostic;
};

describe("@tsuba/compiler diagnostic fixtures", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "../../../..");
  }

  function fixtureRoot(): string {
    return join(repoRoot(), "packages", "compiler", "testdata", "diagnostics");
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function loadCases(): readonly FixtureCase[] {
    const root = fixtureRoot();
    const domains = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const out: FixtureCase[] = [];
    for (const domain of domains) {
      const domainDir = join(root, domain);
      const caseNames = readdirSync(domainDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
      for (const caseName of caseNames) {
        const absDir = join(domainDir, caseName);
        const expectedPath = join(absDir, "expected.json");
        const expected = JSON.parse(readFileSync(expectedPath, "utf-8")) as ExpectedDiagnostic;
        out.push({
          id: `${domain}/${caseName}`,
          domain,
          absDir,
          expected,
        });
      }
    }
    return out;
  }

  function expectCompileError(caseDef: FixtureCase): CompileError {
    const tmp = makeRepoTempDir("compiler-diag-fixture-");
    cpSync(caseDef.absDir, tmp, { recursive: true });
    const entry = join(tmp, "main.ts");

    try {
      compileHostToRust({ entryFile: entry });
      throw new Error(`Expected compile failure for diagnostic fixture: ${caseDef.id}`);
    } catch (error) {
      expect(error).to.be.instanceOf(CompileError);
      return error as CompileError;
    }
  }

  const cases = loadCases();
  const coveredDomains = new Set<string>(cases.map((c) => c.expected.domain));

  for (const c of cases) {
    it(`matches expected diagnostic for fixture ${c.id}`, () => {
      const err = expectCompileError(c);
      expect(isCompilerDiagnosticCode(err.code), `Fixture ${c.id} must produce a registered diagnostic code.`).to.equal(
        true
      );
      expect(err.message.length).to.be.greaterThan(0);
      expect(err.span, `Fixture ${c.id} must carry a source span.`).to.not.equal(undefined);
      expect(err.span?.fileName, `Fixture ${c.id} should map to fixture source.`).to.match(/main\.ts$/);
      expect(err.span?.start, `Fixture ${c.id} span start must be non-negative.`).to.be.gte(0);
      expect(err.span?.end, `Fixture ${c.id} span end must be >= start.`).to.be.gte(err.span?.start ?? 0);
      assertCompilerDiagnosticCode(err.code);
      const domain = compilerDiagnosticDomain(err.code);
      expect(domain).to.equal(c.expected.domain);
      expect(domain).to.equal(c.domain);
      expect(err.code).to.equal(c.expected.code);
      for (const needle of c.expected.messageIncludes ?? []) {
        expect(err.message).to.contain(needle);
      }
    });
  }

  it("covers all primary diagnostic domains with fixture snapshots", () => {
    expect(coveredDomains).to.deep.equal(
      new Set([
        "entry-and-expressions",
        "control-flow",
        "functions-imports-and-annotations",
        "classes-and-methods",
        "types-and-traits",
      ])
    );
  });
});
