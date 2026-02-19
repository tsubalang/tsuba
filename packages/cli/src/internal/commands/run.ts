import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { loadProjectContext } from "../config.js";
import { runBuild } from "./build.js";

export type RunArgs = {
  readonly dir: string;
  readonly stdio?: "inherit" | "pipe";
};

export type RunOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

export async function runRun(args: RunArgs): Promise<RunOutput> {
  // Ensure generated crate is up-to-date and compiles.
  await runBuild({ dir: args.dir });

  const { workspaceRoot, workspace, projectRoot } = loadProjectContext(args.dir);
  const generatedRoot = join(projectRoot, workspace.generatedDirName);

  const cargoTargetDir = resolve(workspaceRoot, workspace.cargoTargetDir);
  mkdirSync(cargoTargetDir, { recursive: true });

  const res = spawnSync("cargo", ["run", "--quiet"], {
    cwd: generatedRoot,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
    encoding: "utf-8",
    stdio: args.stdio ?? "inherit",
  });

  if (res.status !== 0) {
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    throw new Error(`cargo run failed.\n${stdout}${stderr}`);
  }

  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}
