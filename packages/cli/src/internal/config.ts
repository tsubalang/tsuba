import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type WorkspaceConfig = {
  readonly schema: 1;
  readonly rustEdition: "2021" | "2024";
  readonly packagesDir: string;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
  readonly gpu: {
    readonly backend: "none" | "cuda";
    readonly cuda?: {
      readonly toolkitPath: string;
      readonly sm: number;
    };
  };
  readonly runtime: {
    readonly kind: "none" | "tokio";
  };
};

export type ProjectCrateDependency = {
  readonly id: string;
  readonly package?: string;
  readonly version?: string;
  readonly path?: string;
  readonly features?: readonly string[];
};

export type ProjectConfig = {
  readonly schema: 1;
  readonly name: string;
  readonly kind: "bin" | "lib";
  readonly entry: string;
  readonly gpu: {
    readonly enabled: boolean;
  };
  readonly crate: {
    readonly name: string;
  };
  readonly deps?: {
    readonly crates?: readonly ProjectCrateDependency[];
  };
};

export type ProjectContext = {
  readonly workspaceRoot: string;
  readonly workspace: WorkspaceConfig;
  readonly projectRoot: string;
  readonly project: ProjectConfig;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label}: unknown key '${key}'.`);
    }
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function asInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value as number;
}

function asStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  const root = asRecord(value, "tsuba.workspace.json");
  assertKnownKeys(
    root,
    ["schema", "rustEdition", "packagesDir", "generatedDirName", "cargoTargetDir", "gpu", "runtime"],
    "tsuba.workspace.json"
  );

  if (root.schema !== 1) {
    throw new Error("Unsupported tsuba.workspace.json schema.");
  }

  const rustEdition = root.rustEdition;
  if (rustEdition !== "2021" && rustEdition !== "2024") {
    throw new Error(`tsuba.workspace.json: 'rustEdition' must be '2021' or '2024'.`);
  }

  const packagesDir = asString(root.packagesDir, "tsuba.workspace.json: 'packagesDir'");
  const generatedDirName = asString(root.generatedDirName, "tsuba.workspace.json: 'generatedDirName'");
  const cargoTargetDir = asString(root.cargoTargetDir, "tsuba.workspace.json: 'cargoTargetDir'");

  const gpu = asRecord(root.gpu, "tsuba.workspace.json: 'gpu'");
  assertKnownKeys(gpu, ["backend", "cuda"], "tsuba.workspace.json: 'gpu'");
  const backend = gpu.backend;
  if (backend !== "none" && backend !== "cuda") {
    throw new Error(`tsuba.workspace.json: 'gpu.backend' must be 'none' or 'cuda'.`);
  }

  let cuda:
    | {
        readonly toolkitPath: string;
        readonly sm: number;
      }
    | undefined;
  if (backend === "cuda") {
    const cudaRaw = asRecord(gpu.cuda, "tsuba.workspace.json: 'gpu.cuda'");
    assertKnownKeys(cudaRaw, ["toolkitPath", "sm"], "tsuba.workspace.json: 'gpu.cuda'");
    cuda = {
      toolkitPath: asString(cudaRaw.toolkitPath, "tsuba.workspace.json: 'gpu.cuda.toolkitPath'"),
      sm: asInteger(cudaRaw.sm, "tsuba.workspace.json: 'gpu.cuda.sm'"),
    };
  }

  const runtime = asRecord(root.runtime, "tsuba.workspace.json: 'runtime'");
  assertKnownKeys(runtime, ["kind"], "tsuba.workspace.json: 'runtime'");
  if (runtime.kind !== "none" && runtime.kind !== "tokio") {
    throw new Error(`tsuba.workspace.json: 'runtime.kind' must be 'none' or 'tokio'.`);
  }

  return {
    schema: 1,
    rustEdition,
    packagesDir,
    generatedDirName,
    cargoTargetDir,
    gpu: backend === "cuda" ? { backend, cuda } : { backend },
    runtime: { kind: runtime.kind },
  };
}

function parseProjectCrateDependency(value: unknown, index: number): ProjectCrateDependency {
  const dep = asRecord(value, `tsuba.json: 'deps.crates[${index}]'`);
  assertKnownKeys(dep, ["id", "package", "version", "path", "features"], `tsuba.json: 'deps.crates[${index}]'`);

  const id = asString(dep.id, `tsuba.json: 'deps.crates[${index}].id'`);
  const pkg = dep.package === undefined ? undefined : asString(dep.package, `tsuba.json: 'deps.crates[${index}].package'`);
  const version =
    dep.version === undefined ? undefined : asString(dep.version, `tsuba.json: 'deps.crates[${index}].version'`);
  const path = dep.path === undefined ? undefined : asString(dep.path, `tsuba.json: 'deps.crates[${index}].path'`);
  const features =
    dep.features === undefined
      ? undefined
      : asStringArray(dep.features, `tsuba.json: 'deps.crates[${index}].features'`);

  if ((version ? 1 : 0) + (path ? 1 : 0) !== 1) {
    throw new Error(
      `tsuba.json: 'deps.crates[${index}]' must provide exactly one of 'version' or 'path'.`
    );
  }

  return { id, package: pkg, version, path, features };
}

function parseProjectConfig(value: unknown): ProjectConfig {
  const root = asRecord(value, "tsuba.json");
  assertKnownKeys(root, ["schema", "name", "kind", "entry", "gpu", "crate", "deps"], "tsuba.json");

  if (root.schema !== 1) {
    throw new Error("Unsupported tsuba.json schema.");
  }

  const name = asString(root.name, "tsuba.json: 'name'");
  const kind = root.kind;
  if (kind !== "bin" && kind !== "lib") {
    throw new Error(`tsuba.json: 'kind' must be 'bin' or 'lib'.`);
  }
  const entry = asString(root.entry, "tsuba.json: 'entry'");

  const gpu = asRecord(root.gpu, "tsuba.json: 'gpu'");
  assertKnownKeys(gpu, ["enabled"], "tsuba.json: 'gpu'");
  const gpuEnabled = asBoolean(gpu.enabled, "tsuba.json: 'gpu.enabled'");

  const crate = asRecord(root.crate, "tsuba.json: 'crate'");
  assertKnownKeys(crate, ["name"], "tsuba.json: 'crate'");
  const crateName = asString(crate.name, "tsuba.json: 'crate.name'");

  let deps:
    | {
        readonly crates?: readonly ProjectCrateDependency[];
      }
    | undefined;
  if (root.deps !== undefined) {
    const depsRaw = asRecord(root.deps, "tsuba.json: 'deps'");
    assertKnownKeys(depsRaw, ["crates"], "tsuba.json: 'deps'");
    let crates: readonly ProjectCrateDependency[] | undefined;
    if (depsRaw.crates !== undefined) {
      if (!Array.isArray(depsRaw.crates)) {
        throw new Error("tsuba.json: 'deps.crates' must be an array.");
      }
      crates = depsRaw.crates.map((d, i) => parseProjectCrateDependency(d, i));
    }
    deps = crates ? { crates } : {};
  }

  return {
    schema: 1,
    name,
    kind,
    entry,
    gpu: { enabled: gpuEnabled },
    crate: { name: crateName },
    deps,
  };
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as unknown;
}

export function writeProjectConfig(path: string, value: ProjectConfig): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

export function findWorkspaceRoot(fromDir: string): string {
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

export function findProjectRoot(fromDir: string): string {
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

export function loadWorkspaceConfig(path: string): WorkspaceConfig {
  return parseWorkspaceConfig(readJson(path));
}

export function loadProjectConfig(path: string): ProjectConfig {
  return parseProjectConfig(readJson(path));
}

export function loadProjectContext(fromDir: string): ProjectContext {
  const projectRoot = findProjectRoot(fromDir);
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const rel = relative(workspaceRoot, projectRoot).replaceAll("\\", "/");
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error("Resolved project is outside of workspace root.");
  }

  const workspace = loadWorkspaceConfig(join(workspaceRoot, "tsuba.workspace.json"));
  const project = loadProjectConfig(join(projectRoot, "tsuba.json"));
  return { workspaceRoot, workspace, projectRoot, project };
}
