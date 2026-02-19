import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(join(dirname(here), "../../../../.."));
}

type ExternalProofCheck = {
  readonly id: string;
  readonly repo: string;
  readonly required: boolean;
  readonly substantial: boolean;
  readonly categories: readonly string[];
  readonly command: readonly string[];
};

describe("external-proof matrix config", () => {
  it("keeps required categories covered by required internal checks", () => {
    const matrixPath = join(repoRoot(), "spec", "external-proof-matrix.json");
    const matrix = JSON.parse(readFileSync(matrixPath, "utf-8")) as {
      readonly schema: number;
      readonly kind: string;
      readonly requiredCategories: readonly string[];
      readonly minimumPassingSubstantial: number;
      readonly checks: readonly ExternalProofCheck[];
    };

    expect(matrix.schema).to.equal(1);
    expect(matrix.kind).to.equal("external-proof-matrix");
    expect(matrix.minimumPassingSubstantial).to.equal(3);

    const requiredCategories = [...matrix.requiredCategories].sort((a, b) => a.localeCompare(b));
    expect(requiredCategories).to.deep.equal(["bindgen-heavy", "gpu-heavy", "host-service"]);

    const requiredInternal = matrix.checks.filter((c) => c.repo === "." && c.required);
    expect(requiredInternal.length).to.be.greaterThanOrEqual(3);
    for (const category of requiredCategories) {
      const covered = requiredInternal.some((c) => c.categories.includes(category) && c.substantial);
      expect(covered, `missing required internal substantial check for category ${category}`).to.equal(true);
    }
  });
});
