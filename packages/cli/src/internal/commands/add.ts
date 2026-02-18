import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

export type AddArgs = {
  readonly dir: string;
  readonly argv: readonly string[];
};

type ProjectConfig = {
  readonly schema: number;
  readonly deps?: {
    readonly crates?: readonly {
      readonly id: string;
      readonly version?: string;
      readonly path?: string;
      readonly features?: readonly string[];
    }[];
  };
};

function readJson<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
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

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  tsuba add crate <name>@<version>",
      "  tsuba add path <name> <path-to-crate>",
      "  tsuba add npm <package>",
    ].join("\n")
  );
}

function parseCrateSpec(spec: string): { readonly id: string; readonly version: string } {
  const at = spec.lastIndexOf("@");
  if (at === -1) throw new Error(`add crate: expected <name>@<version> (got ${JSON.stringify(spec)})`);
  const id = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (id.length === 0 || version.length === 0) {
    throw new Error(`add crate: expected <name>@<version> (got ${JSON.stringify(spec)})`);
  }
  return { id, version };
}

function addCrateDep(opts: {
  readonly projectRoot: string;
  readonly id: string;
  readonly version?: string;
  readonly path?: string;
}): void {
  if ((opts.version ? 1 : 0) + (opts.path ? 1 : 0) !== 1) {
    throw new Error("add: expected exactly one of {version,path}.");
  }
  const jsonPath = join(opts.projectRoot, "tsuba.json");
  const cfg = readJson<ProjectConfig>(jsonPath);
  if (cfg.schema !== 1) throw new Error("Unsupported tsuba.json schema.");

  const prev = cfg.deps?.crates ?? [];
  if (prev.some((d) => d.id === opts.id)) {
    throw new Error(`add: crate dep '${opts.id}' already exists in tsuba.json.`);
  }

  const next = [
    ...prev,
    opts.path ? { id: opts.id, path: opts.path } : { id: opts.id, version: opts.version! },
  ];
  const out: ProjectConfig = { ...cfg, deps: { ...(cfg.deps ?? {}), crates: next } };
  writeJson(jsonPath, out);
}

export async function runAdd(args: AddArgs): Promise<void> {
  const [kind, ...rest] = args.argv;
  if (!kind) usage();
  if (kind === "--help" || kind === "-h") usage();

  if (kind === "npm") {
    const [pkg] = rest;
    if (!pkg) usage();
    const workspaceRoot = findWorkspaceRoot(args.dir);
    const res = spawnSync("npm", ["install", pkg], { cwd: workspaceRoot, stdio: "inherit" });
    if (res.status !== 0) throw new Error("npm install failed.");
    return;
  }

  const projectRoot = findProjectRoot(args.dir);

  if (kind === "crate") {
    const [spec] = rest;
    if (!spec) usage();
    const { id, version } = parseCrateSpec(spec);
    addCrateDep({ projectRoot, id, version });
    return;
  }

  if (kind === "path") {
    const [id, p] = rest;
    if (!id || !p) usage();
    addCrateDep({ projectRoot, id, path: p });
    return;
  }

  throw new Error(`add: unknown kind: ${kind}`);
}
