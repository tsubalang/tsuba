import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type AddArgs = {
  readonly dir: string;
  readonly argv: readonly string[];
};

export type AddSpawn = (
  command: string,
  args: readonly string[],
  opts: { readonly cwd?: string; readonly stdio?: "inherit"; readonly encoding?: "utf-8" }
) => { readonly status: number | null; readonly stdout?: string; readonly stderr?: string };

type ProjectConfig = {
  readonly schema: number;
  readonly deps?: {
    readonly crates?: readonly {
      readonly id: string;
      readonly package?: string;
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
  readonly package?: string;
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
    opts.path
      ? { id: opts.id, package: opts.package, path: opts.path }
      : { id: opts.id, package: opts.package, version: opts.version! },
  ];
  const out: ProjectConfig = { ...cfg, deps: { ...(cfg.deps ?? {}), crates: next } };
  writeJson(jsonPath, out);
}

type CargoMetadata = {
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly manifest_path: string;
    readonly targets: readonly { readonly name: string; readonly kind: readonly string[] }[];
  }[];
};

function normalizeFeatures(features: readonly string[] | undefined): readonly string[] {
  const sorted = [...(features ?? [])].sort((a, b) => a.localeCompare(b));
  // De-dup
  const out: string[] = [];
  for (const f of sorted) {
    if (out.length === 0 || out[out.length - 1] !== f) out.push(f);
  }
  return out;
}

function featuresKey(features: readonly string[] | undefined): string {
  const fs = normalizeFeatures(features);
  if (fs.length === 0) return "nofeatures";
  const hash = createHash("sha256").update(fs.join(","), "utf-8").digest("hex").slice(0, 12);
  return `features-${hash}`;
}

function readBindingsManifest(path: string): { readonly crate: { readonly name: string; readonly package?: string; readonly version?: string; readonly path?: string; readonly features?: readonly string[] } } {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as any;
  if (!parsed || typeof parsed !== "object") throw new Error(`${path}: expected JSON object.`);
  if (parsed.schema !== 1 || parsed.kind !== "crate") throw new Error(`${path}: unsupported manifest.`);
  if (!parsed.crate || typeof parsed.crate.name !== "string") throw new Error(`${path}: missing crate.name.`);
  return parsed as any;
}

function ensureBindingsPackageLinkedFresh(opts: {
  readonly workspaceRoot: string;
  readonly npmPackageName: string; // "@tsuba/foo"
  readonly cacheDir: string;
}): void {
  const installRoot = join(opts.workspaceRoot, "node_modules", ...opts.npmPackageName.split("/"));
  if (existsSync(installRoot)) {
    throw new Error(
      `Workspace already has ${opts.npmPackageName} at ${installRoot}. Remove it (or choose a different name) and retry.`
    );
  }
  mkdirSync(dirname(installRoot), { recursive: true });
  symlinkSync(opts.cacheDir, installRoot, "dir");
}

function ensureBindingsPackageLinked(opts: {
  readonly workspaceRoot: string;
  readonly npmPackageName: string; // "@tsuba/foo"
  readonly cacheDir: string;
  readonly expectedCrateVersion?: string;
  readonly expectedCratePath?: string;
}): void {
  const installRoot = join(opts.workspaceRoot, "node_modules", ...opts.npmPackageName.split("/"));
  if (existsSync(installRoot)) {
    const manifestPath = join(installRoot, "tsuba.bindings.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Workspace already has ${opts.npmPackageName} at ${installRoot}, but it is missing tsuba.bindings.json. Remove it and retry.`
      );
    }
    const m = readBindingsManifest(manifestPath);
    const gotVersion = m.crate.version;
    const gotPath = m.crate.path;
    const wantVersion = opts.expectedCrateVersion;
    const wantPath = opts.expectedCratePath;
    if ((wantVersion ? 1 : 0) + (wantPath ? 1 : 0) !== 1) {
      throw new Error("Internal error: expected exactly one of {expectedCrateVersion,expectedCratePath}.");
    }
    if (wantVersion) {
      if (gotVersion !== wantVersion) {
        throw new Error(
          `Single-version-per-workspace: ${opts.npmPackageName} is already linked to crate version ${JSON.stringify(
            gotVersion
          )} but you requested ${JSON.stringify(wantVersion)}.`
        );
      }
    } else {
      if (gotPath !== wantPath) {
        throw new Error(
          `Single-path-per-workspace: ${opts.npmPackageName} is already linked to a different crate path.`
        );
      }
    }
    return;
  }

  mkdirSync(dirname(installRoot), { recursive: true });
  symlinkSync(opts.cacheDir, installRoot, "dir");
}

function resolveRegistryCrateManifest(opts: {
  readonly workspaceRoot: string;
  readonly cargoPackage: string;
  readonly version: string;
  readonly spawnSync: AddSpawn;
}): { readonly manifestPath: string; readonly crateName: string; readonly cargoPackage: string } {
  // Use cargo metadata (deterministic) rather than guessing CARGO_HOME registry paths.
  const tmpBase = join(opts.workspaceRoot, ".tsuba", "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const tmp = mkdtempSync(join(tmpBase, "add-crate-"));

  writeFileSync(
    join(tmp, "Cargo.toml"),
    [
      "[package]",
      'name = "tsuba_add_crate_tmp"',
      'version = "0.0.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      `${opts.cargoPackage} = "=${opts.version}"`,
      "",
    ].join("\n"),
    "utf-8"
  );

  const res = opts.spawnSync("cargo", ["metadata", "--format-version", "1"], {
    cwd: tmp,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`cargo metadata failed.\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
  const parsed = JSON.parse(res.stdout ?? "") as CargoMetadata;
  const pkg = parsed.packages.find((p) => p.name === opts.cargoPackage && p.version === opts.version);
  if (!pkg) {
    throw new Error(
      `Could not resolve crate ${opts.cargoPackage}@${opts.version} via cargo metadata.`
    );
  }

  const libTarget =
    pkg.targets.find((t) => t.kind.includes("lib")) ??
    pkg.targets.find((t) => t.kind.includes("proc-macro"));
  if (!libTarget) {
    throw new Error(
      `Crate ${opts.cargoPackage}@${opts.version} does not have a lib/proc-macro target; v0 requires a crate that can be imported.`
    );
  }

  return { manifestPath: pkg.manifest_path, crateName: libTarget.name, cargoPackage: pkg.name };
}

function resolvePathCrateManifest(opts: {
  readonly manifestPath: string;
  readonly spawnSync: AddSpawn;
}): { readonly manifestPath: string; readonly crateName: string; readonly cargoPackage: string } {
  const res = opts.spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", opts.manifestPath],
    { encoding: "utf-8" }
  );
  if (res.status !== 0) {
    throw new Error(`cargo metadata failed.\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  }
  const parsed = JSON.parse(res.stdout ?? "") as CargoMetadata;
  const pkg = parsed.packages.find((p) => resolve(p.manifest_path) === resolve(opts.manifestPath));
  if (!pkg) {
    throw new Error(`Could not find package for manifest ${opts.manifestPath} in cargo metadata output.`);
  }

  const libTarget =
    pkg.targets.find((t) => t.kind.includes("lib")) ??
    pkg.targets.find((t) => t.kind.includes("proc-macro"));
  if (!libTarget) {
    throw new Error(
      `Crate at ${opts.manifestPath} does not have a lib/proc-macro target; v0 requires a crate that can be imported.`
    );
  }

  return { manifestPath: pkg.manifest_path, crateName: libTarget.name, cargoPackage: pkg.name };
}

export async function runAdd(
  args: AddArgs,
  deps?: { readonly spawnSync?: AddSpawn }
): Promise<void> {
  const spawn: AddSpawn =
    deps?.spawnSync ??
    ((command, argv, opts) => spawnSync(command, argv, opts as any) as any);
  const [kind, ...rest] = args.argv;
  if (!kind) usage();
  if (kind === "--help" || kind === "-h") usage();

  if (kind === "npm") {
    const [pkg] = rest;
    if (!pkg) usage();
    const workspaceRoot = findWorkspaceRoot(args.dir);
    const res = spawn("npm", ["install", pkg], { cwd: workspaceRoot, stdio: "inherit" });
    if (res.status !== 0) throw new Error("npm install failed.");
    return;
  }

  const projectRoot = findProjectRoot(args.dir);

  if (kind === "crate") {
    const [spec] = rest;
    if (!spec) usage();
    const workspaceRoot = findWorkspaceRoot(args.dir);
    const { id: cargoPackage, version } = parseCrateSpec(spec);
    const info = resolveRegistryCrateManifest({ workspaceRoot, cargoPackage, version, spawnSync: spawn });

    // Always install facade packages under @tsuba/<cargo-package>.
    const npmPackageName = `@tsuba/${cargoPackage}`;

    const cacheDir = join(
      workspaceRoot,
      ".tsuba",
      "bindings-cache",
      cargoPackage,
      version,
      featuresKey(undefined)
    );

    // If not already generated, run bindgen.
    if (!existsSync(join(cacheDir, "package.json"))) {
      mkdirSync(cacheDir, { recursive: true });
      const res = spawn(
        "tsubabindgen",
        ["--manifest-path", info.manifestPath, "--out", cacheDir, "--package", npmPackageName],
        { stdio: "inherit", encoding: "utf-8" }
      );
      if (res.status !== 0) throw new Error("tsubabindgen failed.");
      if (!existsSync(join(cacheDir, "package.json"))) {
        throw new Error(`tsubabindgen did not produce package.json at ${cacheDir}.`);
      }
    }

    ensureBindingsPackageLinked({
      workspaceRoot,
      npmPackageName,
      cacheDir,
      expectedCrateVersion: version,
    });

    addCrateDep({
      projectRoot,
      id: info.crateName,
      package: info.cargoPackage !== info.crateName ? info.cargoPackage : undefined,
      version,
    });
    return;
  }

  if (kind === "path") {
    const [id, p] = rest;
    if (!id || !p) usage();
    const workspaceRoot = findWorkspaceRoot(args.dir);
    const crateRoot = resolve(projectRoot, p);
    const manifestPath = join(crateRoot, "Cargo.toml");
    if (!existsSync(manifestPath)) {
      throw new Error(`add path: expected Cargo.toml at ${manifestPath}`);
    }

    const info = resolvePathCrateManifest({ manifestPath, spawnSync: spawn });
    const npmPackageName = `@tsuba/${id}`;

    const pathHash = createHash("sha256").update(crateRoot, "utf-8").digest("hex").slice(0, 12);
    const cacheDir = join(
      workspaceRoot,
      ".tsuba",
      "bindings-cache",
      id,
      `path-${pathHash}`,
      featuresKey(undefined)
    );

    if (!existsSync(join(cacheDir, "package.json"))) {
      mkdirSync(cacheDir, { recursive: true });
      const res = spawn(
        "tsubabindgen",
        ["--manifest-path", info.manifestPath, "--out", cacheDir, "--package", npmPackageName, "--bundle-crate"],
        { stdio: "inherit", encoding: "utf-8" }
      );
      if (res.status !== 0) throw new Error("tsubabindgen failed.");
      if (!existsSync(join(cacheDir, "package.json"))) {
        throw new Error(`tsubabindgen did not produce package.json at ${cacheDir}.`);
      }
    }

    ensureBindingsPackageLinkedFresh({ workspaceRoot, npmPackageName, cacheDir });

    const crateDirInWorkspace = join(
      workspaceRoot,
      "node_modules",
      ...npmPackageName.split("/"),
      "crate"
    );
    // Record path relative to the project root for portability inside the workspace.
    const relPath = relative(projectRoot, crateDirInWorkspace).replaceAll("\\", "/");

    addCrateDep({
      projectRoot,
      id: info.crateName,
      package: info.cargoPackage !== info.crateName ? info.cargoPackage : undefined,
      path: relPath,
    });
    return;
  }

  throw new Error(`add: unknown kind: ${kind}`);
}
