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
  const scriptPath = join(repoRoot(), "scripts", "verify-external-proof.mjs");
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

describe("verify-external-proof script", () => {
  it("passes in best-effort mode when external proof repos are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-external-proof-missing-"));
    const configPath = join(root, "external-proof.json");
    const reportPath = join(root, ".tsuba", "external-proof.latest.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          schema: 1,
          kind: "external-proof-matrix",
          requiredCategories: ["host-service"],
          minimumPassingSubstantial: 1,
          checks: [
            {
              id: "missing-proof",
              repo: "./missing-repo",
              command: ["bash", "scripts/verify.sh"],
              categories: ["host-service"],
              substantial: true,
              required: true,
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = runScript(["--root", root, "--config", configPath, "--report", reportPath, "--pretty"]);
    expect(result.status).to.equal(0);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.status).to.equal("passed");
    expect(report.summary.missing).to.equal(1);
  });

  it("fails in require mode when required external proof targets are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-external-proof-require-missing-"));
    const configPath = join(root, "external-proof.json");
    const reportPath = join(root, ".tsuba", "external-proof.latest.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          schema: 1,
          kind: "external-proof-matrix",
          requiredCategories: ["host-service"],
          minimumPassingSubstantial: 1,
          checks: [
            {
              id: "missing-proof",
              repo: "./missing-repo",
              command: ["bash", "scripts/verify.sh"],
              categories: ["host-service"],
              substantial: true,
              required: true,
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = runScript(["--root", root, "--config", configPath, "--report", reportPath, "--require"]);
    expect(result.status).to.equal(1);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.status).to.equal("failed");
    expect(report.failures.some((x: string) => x.includes("missing-proof"))).to.equal(true);
  });

  it("passes in require mode when all categories and substantial checks pass", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-external-proof-ok-"));
    const repos = ["host", "gpu", "bindgen"].map((name) => {
      const repoPath = join(root, `${name}-repo`);
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        join(repoPath, "verify.sh"),
        ["#!/usr/bin/env bash", "set -euo pipefail", "echo ok"].join("\n") + "\n",
        "utf-8"
      );
      return repoPath;
    });
    const configPath = join(root, "external-proof.json");
    const reportPath = join(root, ".tsuba", "external-proof.latest.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          schema: 1,
          kind: "external-proof-matrix",
          requiredCategories: ["bindgen-heavy", "gpu-heavy", "host-service"],
          minimumPassingSubstantial: 3,
          checks: [
            {
              id: "host",
              repo: repos[0],
              command: ["bash", "verify.sh"],
              categories: ["host-service"],
              substantial: true,
              required: true,
            },
            {
              id: "gpu",
              repo: repos[1],
              command: ["bash", "verify.sh"],
              categories: ["gpu-heavy"],
              substantial: true,
              required: true,
            },
            {
              id: "bindgen",
              repo: repos[2],
              command: ["bash", "verify.sh"],
              categories: ["bindgen-heavy"],
              substantial: true,
              required: true,
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const result = runScript(["--root", root, "--config", configPath, "--report", reportPath, "--require"]);
    expect(result.status).to.equal(0);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.status).to.equal("passed");
    expect(report.summary.passed).to.equal(3);
    expect(report.summary.substantialPassed).to.equal(3);
    expect(report.missingCategories).to.deep.equal([]);
  });
});
