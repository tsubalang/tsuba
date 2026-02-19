import { expect } from "chai";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(join(dirname(here), "../../../../.."));
}

function runCommand(cwd: string, command: string, args: readonly string[]): void {
  const proc = spawnSync(command, [...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if ((proc.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${proc.stderr ?? ""}`);
  }
}

function runScript(args: readonly string[]): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const scriptPath = join(repoRoot(), "scripts", "check-signed-head-tag.mjs");
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

function initTempGitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "tsuba-signed-tag-"));
  runCommand(root, "git", ["init"]);
  runCommand(root, "git", ["config", "user.email", "test@example.com"]);
  runCommand(root, "git", ["config", "user.name", "Test User"]);
  writeFileSync(join(root, "README.md"), "x\n", "utf-8");
  runCommand(root, "git", ["add", "."]);
  runCommand(root, "git", ["commit", "-m", "init"]);
  return root;
}

describe("check-signed-head-tag script", () => {
  it("reports unsigned tags and fails in --require mode", () => {
    const root = initTempGitRepo();
    const reportPath = join(root, ".tsuba", "signed-tag-report.json");
    runCommand(root, "git", ["tag", "v0.0.1"]);

    const result = runScript(["--root", root, "--report", reportPath, "--require"]);
    expect(result.status).to.equal(1);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.summary.tagCount).to.equal(1);
    expect(report.summary.signedTagCount).to.equal(0);
    expect(report.summary.hasSignedTag).to.equal(false);
  });

  it("passes without --require even when no signed tags are present", () => {
    const root = initTempGitRepo();
    const reportPath = join(root, ".tsuba", "signed-tag-report.json");

    const result = runScript(["--root", root, "--report", reportPath]);
    expect(result.status).to.equal(0);
    const report = JSON.parse(readFileSync(reportPath, "utf-8")) as any;
    expect(report.summary.hasSignedTag).to.equal(false);
  });
});
