import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { compileHostToRust } from "@tsuba/compiler";

type WorkspaceConfig = {
  readonly schema: number;
  readonly packagesDir: string;
  readonly generatedDirName: string;
};

type ProjectConfig = {
  readonly schema: number;
  readonly name: string;
  readonly kind: "bin" | "lib";
  readonly entry: string;
};

export type BuildArgs = {
  readonly dir: string;
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

export async function runBuild(args: BuildArgs): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(args.dir);
  const workspace = readJson<WorkspaceConfig>(join(workspaceRoot, "tsuba.workspace.json"));
  const projectRoot = findProjectRoot(args.dir);
  const project = readJson<ProjectConfig>(join(projectRoot, "tsuba.json"));

  if (workspace.schema !== 1) throw new Error("Unsupported tsuba.workspace.json schema.");
  if (project.schema !== 1) throw new Error("Unsupported tsuba.json schema.");

  const entryFile = resolve(projectRoot, project.entry);
  const out = compileHostToRust({ entryFile });

  const generatedRoot = join(projectRoot, workspace.generatedDirName);
  const generatedSrcDir = join(generatedRoot, "src");
  mkdirSync(generatedSrcDir, { recursive: true });

  writeFileSync(join(generatedRoot, "Cargo.toml"), out.cargoToml, "utf-8");
  writeFileSync(join(generatedSrcDir, "main.rs"), out.mainRs, "utf-8");
}
