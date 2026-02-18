import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { compileHostToRust } from "@tsuba/compiler";

import { mergeCargoDependencies, renderCargoToml } from "./cargo.js";

type WorkspaceConfig = {
  readonly schema: number;
  readonly rustEdition: "2021" | "2024";
  readonly packagesDir: string;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
  readonly gpu: {
    readonly backend: "none" | "cuda";
  };
};

type ProjectConfig = {
  readonly schema: number;
  readonly name: string;
  readonly kind: "bin" | "lib";
  readonly entry: string;
  readonly crate: {
    readonly name: string;
  };
  readonly deps?: {
    readonly crates?: readonly {
      readonly id: string;
      readonly version?: string;
      readonly path?: string;
      readonly features?: readonly string[];
    }[];
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

  if (out.kernels.length > 0) {
    if (workspace.gpu.backend !== "cuda") {
      throw new Error(
        "GPU kernels were found, but tsuba.workspace.json has gpu.backend='none'. Set it to 'cuda' to enable kernel compilation."
      );
    }

    const nvcc = spawnSync("nvcc", ["--version"], { encoding: "utf-8" });
    if (nvcc.status !== 0) {
      const stderr = nvcc.stderr ?? "";
      throw new Error(`gpu.backend='cuda' but nvcc was not found.\n${stderr}`);
    }

    throw new Error("gpu.backend='cuda' is not implemented yet in v0 (kernel compilation pending).");
  }

  const generatedRoot = join(projectRoot, workspace.generatedDirName);
  const generatedSrcDir = join(generatedRoot, "src");
  mkdirSync(generatedSrcDir, { recursive: true });

  const declaredCrates =
    project.deps?.crates?.map((d) => {
      if ((d.version ? 1 : 0) + (d.path ? 1 : 0) !== 1) {
        throw new Error(
          `Invalid crate dep '${d.id}': expected exactly one of {version,path} in tsuba.json.`
        );
      }
      if (d.path) {
        return { name: d.id, path: resolve(projectRoot, d.path), features: d.features };
      }
      return { name: d.id, version: d.version!, features: d.features };
    }) ?? [];
  const crates = mergeCargoDependencies(declaredCrates, out.crates);
  const cargoToml = renderCargoToml({
    crateName: project.crate.name,
    rustEdition: workspace.rustEdition,
    deps: crates,
  });

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
