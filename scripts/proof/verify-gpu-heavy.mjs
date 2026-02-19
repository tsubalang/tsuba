#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";

import { compileHostToRust } from "@tsuba/compiler";

import {
  cleanupTemp,
  collectTsStats,
  copyTemplate,
  makeTempWorkspace,
  repoRootFrom,
  writeProofReport,
} from "./common.mjs";

function assertContainsAll(text, fragments, label) {
  for (const fragment of fragments) {
    if (!text.includes(fragment)) {
      throw new Error(`${label}: missing fragment ${JSON.stringify(fragment)}`);
    }
  }
}

function main() {
  const rootDir = repoRootFrom(import.meta.url);
  const templateDir = join(rootDir, "test", "proof-codebases", "gpu-heavy");
  if (!existsSync(templateDir)) {
    throw new Error(`Missing gpu-heavy proof template at ${templateDir}.`);
  }

  const stats = collectTsStats(templateDir);
  if (stats.files < 2 || stats.lines < 70) {
    throw new Error(`gpu-heavy proof template is too small (files=${stats.files}, lines=${stats.lines}).`);
  }

  const tempRoot = makeTempWorkspace(rootDir, "proof-gpu-heavy");
  copyTemplate(templateDir, tempRoot);
  const entryFile = join(tempRoot, "packages", "gpu-heavy", "src", "main.ts");

  try {
    const output = compileHostToRust({ entryFile, runtimeKind: "none" });
    if (output.kernels.length < 3) {
      throw new Error(`Expected at least 3 kernels, got ${output.kernels.length}.`);
    }
    const kernelNames = output.kernels.map((k) => k.name).sort((a, b) => a.localeCompare(b));
    assertContainsAll(kernelNames.join(","), ["proof_block_reduce", "proof_histogram", "proof_saxpy"], "kernel set");
    assertContainsAll(output.mainRs, ["mod __tsuba_cuda {", "launch_proof_saxpy", "launch_proof_histogram"], "main.rs");

    const reportPath = writeProofReport(rootDir, "gpu-heavy", {
      schema: 1,
      kind: "proof-check",
      check: "gpu-heavy",
      status: "passed",
      generatedAt: new Date().toISOString(),
      templateDir,
      tempRoot,
      stats,
      kernelCount: output.kernels.length,
      kernelNames,
    });
    process.stdout.write(`PASS gpu-heavy proof (${reportPath})\n`);
    cleanupTemp(tempRoot);
  } catch (error) {
    writeProofReport(rootDir, "gpu-heavy", {
      schema: 1,
      kind: "proof-check",
      check: "gpu-heavy",
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
