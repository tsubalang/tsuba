import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PerfMetrics = {
  readonly schema: 1;
  readonly kind: "e2e-metrics";
  readonly generatedAt: string;
  readonly projects: readonly {
    readonly fixture: string;
    readonly project: string;
    readonly buildMs: number;
    readonly runMs: number;
    readonly testMs: number;
    readonly goldenMs: number;
    readonly buildRssKb: number;
    readonly runRssKb: number;
    readonly testRssKb: number;
    readonly goldenRssKb: number;
    readonly totalMs: number;
    readonly totalRssKb: number;
  }[];
  readonly fixtures: readonly unknown[];
  readonly summary: {
    readonly projects: number;
    readonly totalMs: number;
    readonly buildMs: number;
    readonly runMs: number;
    readonly testMs: number;
    readonly goldenMs: number;
    readonly totalRssKb: number;
    readonly buildRssKb: number;
    readonly runRssKb: number;
    readonly testRssKb: number;
    readonly goldenRssKb: number;
  };
};

describe("@tsuba/cli release operations scripts", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../.."));
  }

  function runNode(scriptPath: string, args: readonly string[]) {
    return spawnSync("node", [scriptPath, ...args], {
      cwd: repoRoot(),
      encoding: "utf-8",
    });
  }

  it("emits release notes JSON in offline mode", () => {
    const script = join(repoRoot(), "scripts", "release-notes.mjs");
    const res = runNode(script, ["--from", "HEAD~1", "--to", "HEAD", "--offline", "--format", "json"]);
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).to.equal(0);
    const report = JSON.parse(res.stdout) as {
      readonly schema: number;
      readonly kind: string;
      readonly from: string;
      readonly to: string;
      readonly pulls: readonly unknown[];
    };
    expect(report.schema).to.equal(1);
    expect(report.kind).to.equal("release-notes");
    expect(report.from).to.equal("HEAD~1");
    expect(report.to).to.equal("HEAD");
    expect(Array.isArray(report.pulls)).to.equal(true);
  });

  it("fails release notes without --from", () => {
    const script = join(repoRoot(), "scripts", "release-notes.mjs");
    const res = runNode(script, ["--offline", "--format", "json"]);
    expect(res.status).to.not.equal(0);
    const stderr = `${res.stderr ?? ""}${res.stdout ?? ""}`;
    expect(stderr).to.contain("--from is required (or pass --auto-range)");
  });

  it("supports release notes auto-range mode", () => {
    const script = join(repoRoot(), "scripts", "release-notes.mjs");
    const res = runNode(script, ["--auto-range", "--offline", "--format", "json"]);
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).to.equal(0);
    const report = JSON.parse(res.stdout) as {
      readonly schema: number;
      readonly kind: string;
      readonly from: string;
      readonly to: string;
    };
    expect(report.schema).to.equal(1);
    expect(report.kind).to.equal("release-notes");
    expect(report.from.length).to.be.greaterThan(0);
    expect(report.to).to.equal("HEAD");
  });

  it("checks perf budgets and returns failing exit code on regression", () => {
    const script = join(repoRoot(), "scripts", "check-perf-budgets.mjs");
    const tempDir = mkdtempSync(join(tmpdir(), "tsuba-perf-budgets-"));
    const metricsPath = join(tempDir, "metrics.json");
    const budgetPath = join(tempDir, "budget.json");

    const metrics: PerfMetrics = {
      schema: 1,
      kind: "e2e-metrics",
      generatedAt: "2026-01-01T00:00:00.000Z",
      projects: [
        {
          fixture: "host-basic",
          project: "host-basic",
          buildMs: 500,
          runMs: 120,
          testMs: 200,
          goldenMs: 140,
          buildRssKb: 2000,
          runRssKb: 1000,
          testRssKb: 1500,
          goldenRssKb: 0,
          totalMs: 960,
          totalRssKb: 4500,
        },
      ],
      fixtures: [],
      summary: {
        projects: 1,
        totalMs: 960,
        buildMs: 500,
        runMs: 120,
        testMs: 200,
        goldenMs: 140,
        totalRssKb: 4500,
        buildRssKb: 2000,
        runRssKb: 1000,
        testRssKb: 1500,
        goldenRssKb: 0,
      },
    };

    writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
    writeFileSync(
      budgetPath,
      `${JSON.stringify(
        {
          schema: 1,
          kind: "perf-budgets",
          fixtureBudgets: {
            default: {
              maxBuildMs: 1000,
              maxRunMs: 500,
              maxTestMs: 500,
              maxGoldenMs: 500,
              maxTotalMs: 1500,
              maxBuildRssKb: 4000,
              maxRunRssKb: 2000,
              maxTestRssKb: 2000,
              maxGoldenRssKb: 1000,
              maxTotalRssKb: 10000,
            },
          },
          suiteBudgets: {
            maxE2eTotalMs: 2000,
            maxE2eTotalRssKb: 20000,
          },
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const passRes = runNode(script, ["--metrics", metricsPath, "--budget", budgetPath]);
    expect(passRes.status, `${passRes.stdout ?? ""}${passRes.stderr ?? ""}`).to.equal(0);
    expect(`${passRes.stdout ?? ""}${passRes.stderr ?? ""}`).to.contain("PASS: performance budgets satisfied");

    writeFileSync(
      budgetPath,
      `${JSON.stringify(
        {
          schema: 1,
          kind: "perf-budgets",
          fixtureBudgets: {
            default: {
              maxBuildMs: 400,
              maxBuildRssKb: 1000,
            },
          },
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const failRes = runNode(script, ["--metrics", metricsPath, "--budget", budgetPath]);
    expect(failRes.status).to.equal(1);
    expect(`${failRes.stdout ?? ""}${failRes.stderr ?? ""}`).to.contain("FAIL: performance budgets exceeded");
    expect(`${failRes.stdout ?? ""}${failRes.stderr ?? ""}`).to.contain("host-basic/host-basic build");
  });
});
