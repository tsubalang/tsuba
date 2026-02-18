import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { runBuild } from "./build.js";

type WorkspaceConfig = {
  readonly schema: number;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
};

export type RunArgs = {
  readonly dir: string;
  readonly stdio?: "inherit" | "pipe";
};

export type RunOutput = {
  readonly stdout: string;
  readonly stderr: string;
};

function readJson<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

function findWorkspaceRoot(fromDir: string): string {
  let cur = resolve(fromDir);
  while (true) {
    const candidate = join(cur, "tsuba.workspace.json");
    try {
      readFileSync(candidate, "utf-8");
      return cur;
    } catch {
      // continue
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Could not find tsuba.workspace.json in this directory or any parent.");
}

function findProjectRoot(fromDir: string): string {
  let cur = resolve(fromDir);
  while (true) {
    const candidate = join(cur, "tsuba.json");
    try {
      readFileSync(candidate, "utf-8");
      return cur;
    } catch {
      // continue
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Could not find tsuba.json in this directory or any parent.");
}

export async function runRun(args: RunArgs): Promise<RunOutput> {
  // Ensure generated crate is up-to-date and compiles.
  await runBuild({ dir: args.dir });

  const workspaceRoot = findWorkspaceRoot(args.dir);
  const workspace = readJson<WorkspaceConfig>(join(workspaceRoot, "tsuba.workspace.json"));

  if (workspace.schema !== 1) throw new Error("Unsupported tsuba.workspace.json schema.");

  const projectRoot = findProjectRoot(args.dir);
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
