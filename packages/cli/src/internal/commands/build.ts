import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { compileHostToRust } from "@tsuba/compiler";

type WorkspaceConfig = {
  readonly schema: number;
  readonly rustEdition: "2021" | "2024";
  readonly packagesDir: string;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
};

type ProjectConfig = {
  readonly schema: number;
  readonly name: string;
  readonly kind: "bin" | "lib";
  readonly entry: string;
  readonly crate: {
    readonly name: string;
  };
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

  if (project.kind !== "bin") throw new Error("Only kind=bin is supported in v0.");

  const entryFile = resolve(projectRoot, project.entry);
  const out = compileHostToRust({ entryFile });

  const generatedRoot = join(projectRoot, workspace.generatedDirName);
  const generatedSrcDir = join(generatedRoot, "src");
  mkdirSync(generatedSrcDir, { recursive: true });

  const cargoToml = [
    "[package]",
    `name = ${JSON.stringify(project.crate.name)}`,
    'version = "0.0.0"',
    `edition = ${JSON.stringify(workspace.rustEdition)}`,
    "",
    "[dependencies]",
    "",
  ].join("\n");

  writeFileSync(join(generatedRoot, "Cargo.toml"), cargoToml, "utf-8");
  writeFileSync(join(generatedSrcDir, "main.rs"), out.mainRs, "utf-8");

  const cargoTargetDir = resolve(workspaceRoot, workspace.cargoTargetDir);
  mkdirSync(cargoTargetDir, { recursive: true });

  const res = spawnSync("cargo", ["build", "--quiet"], {
    cwd: generatedRoot,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
    encoding: "utf-8",
  });

  if (res.status !== 0) {
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    throw new Error(`cargo build failed.\n${stdout}${stderr}`);
  }
}
