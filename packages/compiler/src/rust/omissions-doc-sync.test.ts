import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("@tsuba/compiler omissions docs sync", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function load(pathFromRoot: string): string {
    return readFileSync(join(repoRoot(), pathFromRoot), "utf-8");
  }

  function extractExpectedUnsupportedCodes(testSource: string): readonly string[] {
    const matches = [...testSource.matchAll(/expectedCode:\s*"(?<code>TSB\d{4})"/g)];
    const codes = matches
      .map((m) => m.groups?.code)
      .filter((code): code is string => typeof code === "string");
    return [...new Set(codes)].sort();
  }

  it("documents every unsupported-syntax matrix diagnostic code in omissions-v0.md", () => {
    const unsupportedMatrix = load("packages/compiler/src/rust/unsupported-syntax-matrix.test.ts");
    const omissionsDoc = load("spec/omissions-v0.md");

    const matrixCodes = extractExpectedUnsupportedCodes(unsupportedMatrix);
    const documentedCodes = new Set((omissionsDoc.match(/TSB\d{4}/g) ?? []).map((s) => s.trim()));
    const missing = matrixCodes.filter((code) => !documentedCodes.has(code));

    expect(missing, `Missing omission-doc coverage for: ${missing.join(", ")}`).to.deep.equal([]);
  });

  it("keeps critical TS omission classes explicitly documented", () => {
    const omissionsDoc = load("spec/omissions-v0.md");
    const requiredPhrases = [
      "generators",
      "async generators",
      "for await",
      "optional chaining",
      "nullish coalescing",
      "destructuring",
      "namespace imports",
      "TS `enum` declarations",
      "class inheritance",
      "Promise chaining",
    ] as const;

    for (const phrase of requiredPhrases) {
      expect(
        omissionsDoc.toLowerCase(),
        `Expected omissions-v0.md to include '${phrase}'`
      ).to.contain(phrase.toLowerCase());
    }
  });
});
