import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ReleaseTraceabilityReport = {
  readonly schema: number;
  readonly kind: string;
  readonly git: {
    readonly commit: string;
    readonly branch: string;
  };
  readonly npmPackages: readonly { readonly name: string; readonly version: string; readonly path: string }[];
  readonly crates: readonly { readonly name: string; readonly version: string; readonly manifestPath: string }[];
};

describe("@tsuba/cli release traceability report", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../.."));
  }

  function runTraceability(args: readonly string[]): ReleaseTraceabilityReport {
    const root = repoRoot();
    const script = join(root, "scripts", "release-traceability.mjs");
    const res = spawnSync("node", [script, ...args], { cwd: root, encoding: "utf-8" });
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).to.equal(0);
    const text = (res.stdout ?? "").trim();
    return JSON.parse(text) as ReleaseTraceabilityReport;
  }

  it("emits deterministic release metadata to stdout", () => {
    const report = runTraceability([]);
    expect(report.schema).to.equal(1);
    expect(report.kind).to.equal("release-traceability");
    expect(report.git.commit).to.match(/^[0-9a-f]{40}$|^UNKNOWN$/);
    expect(report.git.branch.length).to.be.greaterThan(0);
    expect(report.npmPackages.length).to.be.greaterThan(0);
    expect(report.crates.length).to.be.greaterThan(0);
    expect(report.npmPackages.some((pkg) => pkg.name === "@tsuba/cli")).to.equal(true);
    const sorted = [...report.npmPackages].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    expect(report.npmPackages).to.deep.equal(sorted);
  });

  it("writes metadata to a file when --out is provided", () => {
    const root = repoRoot();
    const outDir = mkdtempSync(join(tmpdir(), "tsuba-traceability-"));
    const outPath = join(outDir, "report.json");
    const script = join(root, "scripts", "release-traceability.mjs");
    const res = spawnSync("node", [script, "--out", outPath, "--pretty"], { cwd: root, encoding: "utf-8" });
    expect(res.status, `${res.stdout ?? ""}${res.stderr ?? ""}`).to.equal(0);
    const parsed = JSON.parse(readFileSync(outPath, "utf-8")) as ReleaseTraceabilityReport;
    expect(parsed.schema).to.equal(1);
    expect(parsed.kind).to.equal("release-traceability");
  });
});
