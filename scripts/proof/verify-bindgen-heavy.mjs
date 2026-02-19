#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  cleanupTemp,
  collectTsStats,
  copyTemplate,
  findCliBin,
  makeTempWorkspace,
  repoRootFrom,
  runChecked,
  writeProofReport,
} from "./common.mjs";

function main() {
  const rootDir = repoRootFrom(import.meta.url);
  const cliBin = findCliBin(rootDir);
  if (!existsSync(cliBin)) {
    throw new Error(`Missing built CLI at ${cliBin}. Run npm run -w @tsuba/cli build first.`);
  }

  const templateDir = join(rootDir, "test", "proof-codebases", "bindgen-heavy");
  const stats = collectTsStats(templateDir);
  if (stats.files < 1 || stats.lines < 20) {
    throw new Error(
      `bindgen-heavy proof TS surface is too small (files=${stats.files}, lines=${stats.lines}).`
    );
  }

  const tempRoot = makeTempWorkspace(rootDir, "proof-bindgen-heavy");
  copyTemplate(templateDir, tempRoot);
  const projectDir = join(tempRoot, "packages", "bindgen-heavy");
  const manifestPath = join(tempRoot, "vendor", "proof-analytics", "Cargo.toml");

  try {
    runChecked(
      "node",
      [
        cliBin,
        "bindgen",
        "--manifest-path",
        manifestPath,
        "--out",
        join(tempRoot, "node_modules", "@tsuba", "proof-analytics"),
        "--package",
        "@tsuba/proof-analytics",
        "--bundle-crate",
      ],
      tempRoot,
      "bindgen-heavy bindgen"
    );

    runChecked("node", [cliBin, "build"], projectDir, "bindgen-heavy build");
    const runOut = runChecked("node", [cliBin, "run"], projectDir, "bindgen-heavy run");
    runChecked("node", [cliBin, "test"], projectDir, "bindgen-heavy test");

    if (!runOut.stdout.includes("proof-bindgen-heavy")) {
      throw new Error(
        `bindgen-heavy run output missing marker.\n--- stdout ---\n${runOut.stdout}\n--- stderr ---\n${runOut.stderr}`
      );
    }

    const reportPath = writeProofReport(rootDir, "bindgen-heavy", {
      schema: 1,
      kind: "proof-check",
      check: "bindgen-heavy",
      status: "passed",
      generatedAt: new Date().toISOString(),
      templateDir,
      tempRoot,
      manifestPath,
      stats,
      marker: "proof-bindgen-heavy",
    });
    process.stdout.write(`PASS bindgen-heavy proof (${reportPath})\n`);
    cleanupTemp(tempRoot);
  } catch (error) {
    writeProofReport(rootDir, "bindgen-heavy", {
      schema: 1,
      kind: "proof-check",
      check: "bindgen-heavy",
      status: "failed",
      generatedAt: new Date().toISOString(),
      templateDir,
      tempRoot,
      manifestPath,
      stats,
      error: String(error),
    });
    throw error;
  }
}

main();
