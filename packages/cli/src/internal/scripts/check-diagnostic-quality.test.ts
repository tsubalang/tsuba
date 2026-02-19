import { expect } from "chai";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(join(dirname(here), "../../../../.."));
}

function runScript(args: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const scriptPath = join(repoRoot(), "scripts", "check-diagnostic-quality.mjs");
  const proc = spawnSync("node", [scriptPath, ...args], {
    cwd: repoRoot(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

function createSyntheticRoot(root: string): void {
  writeFile(
    join(root, "packages", "compiler", "src", "rust", "diagnostics.ts"),
    [
      "export const COMPILER_DIAGNOSTIC_CODES = {",
      '  A: "TSB1000",',
      '  B: "TSB2000",',
      '  C: "TSB3000",',
      "};",
      "",
    ].join("\n")
  );

  writeFile(join(root, "packages", "compiler", "testdata", "diagnostics", "d1.ts"), "export const a = 1;\n");
  writeFile(join(root, "packages", "compiler", "testdata", "diagnostics", "d2.ts"), "export const b = 2;\n");

  const matrixFiles = [
    "diagnostic-fixtures.test.ts",
    "diagnostic-matrix.test.ts",
    "diagnostic-normalization.test.ts",
    "function-semantics-matrix.test.ts",
    "risk-regressions.test.ts",
    "supported-syntax-matrix.test.ts",
    "unsupported-syntax-matrix.test.ts",
  ];
  for (const file of matrixFiles) {
    writeFile(
      join(root, "packages", "compiler", "src", "rust", file),
      ['describe("x", () => {', '  it("a", () => {});', '  it("b", () => {});', "});", ""].join("\n")
    );
  }
}

describe("check-diagnostic-quality script", () => {
  it("passes when metrics satisfy baseline thresholds", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-diag-quality-pass-"));
    const baselinePath = join(root, "baseline.json");
    const reportPath = join(root, ".tsuba", "diag-quality.json");
    createSyntheticRoot(root);

    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          schema: 1,
          kind: "diagnostic-quality-baseline",
          minimums: {
            diagnosticCodeCount: 3,
            fixtureFileCount: 2,
            matrixTestCaseCount: 14,
          },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = runScript(["--root", root, "--baseline", baselinePath, "--report", reportPath, "--pretty"]);
    expect(result.status).to.equal(0);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.status).to.equal("passed");
    expect(report.metrics.diagnosticCodeCount).to.equal(3);
    expect(report.metrics.fixtureFileCount).to.equal(2);
    expect(report.metrics.matrixTestCaseCount).to.equal(14);
  });

  it("fails when metrics regress below baseline thresholds", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-diag-quality-fail-"));
    const baselinePath = join(root, "baseline.json");
    const reportPath = join(root, ".tsuba", "diag-quality.json");
    createSyntheticRoot(root);

    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          schema: 1,
          kind: "diagnostic-quality-baseline",
          minimums: {
            diagnosticCodeCount: 4,
            fixtureFileCount: 3,
            matrixTestCaseCount: 15,
          },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = runScript(["--root", root, "--baseline", baselinePath, "--report", reportPath]);
    expect(result.status).to.equal(1);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.status).to.equal("failed");
    expect(report.failures.length).to.equal(3);
  });
});
