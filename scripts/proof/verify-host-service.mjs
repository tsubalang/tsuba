#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  collectTsStats,
  copyTemplate,
  findCliBin,
  makeTempWorkspace,
  repoRootFrom,
  runChecked,
  writeProofReport,
  cleanupTemp,
} from "./common.mjs";

function main() {
  const rootDir = repoRootFrom(import.meta.url);
  const cliBin = findCliBin(rootDir);
  if (!existsSync(cliBin)) {
    throw new Error(`Missing built CLI at ${cliBin}. Run npm run -w @tsuba/cli build first.`);
  }

  const templateDir = join(rootDir, "test", "proof-codebases", "host-service");
  const stats = collectTsStats(templateDir);
  if (stats.files < 4 || stats.lines < 120) {
    throw new Error(
      `host-service proof template is not substantial enough (files=${stats.files}, lines=${stats.lines}).`
    );
  }

  const tempRoot = makeTempWorkspace(rootDir, "proof-host-service");
  copyTemplate(templateDir, tempRoot);
  const projectDir = join(tempRoot, "packages", "host-service");

  try {
    runChecked("node", [cliBin, "build"], projectDir, "host-service build");
    const runOut = runChecked("node", [cliBin, "run"], projectDir, "host-service run");
    runChecked("node", [cliBin, "test"], projectDir, "host-service test");
    if (!runOut.stdout.includes("proof-host-service")) {
      throw new Error(
        `host-service run output missing marker.\n--- stdout ---\n${runOut.stdout}\n--- stderr ---\n${runOut.stderr}`
      );
    }

    const reportPath = writeProofReport(rootDir, "host-service", {
      schema: 1,
      kind: "proof-check",
      check: "host-service",
      status: "passed",
      generatedAt: new Date().toISOString(),
      templateDir,
      tempRoot,
      stats,
      marker: "proof-host-service",
    });
    process.stdout.write(`PASS host-service proof (${reportPath})\n`);
    cleanupTemp(tempRoot);
  } catch (error) {
    writeProofReport(rootDir, "host-service", {
      schema: 1,
      kind: "proof-check",
      check: "host-service",
      status: "failed",
      generatedAt: new Date().toISOString(),
      templateDir,
      tempRoot,
      stats,
      error: String(error),
    });
    throw error;
  }
}

main();
