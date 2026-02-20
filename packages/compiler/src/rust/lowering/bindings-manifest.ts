import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { normalizePath } from "./common.js";

export type BindingsManifest = {
  readonly schema: number;
  readonly kind: "crate";
  readonly crate: {
    readonly name: string;
    readonly package?: string;
    readonly version?: string;
    readonly path?: string;
    readonly features?: readonly string[];
  };
  readonly modules: Record<string, string>;
};

const markerModuleSpecifiers = new Set<string>([
  "@tsuba/core/lang.js",
  "@tsuba/core/types.js",
  "@tsuba/std/prelude.js",
  "@tsuba/std/macros.js",
  "@tsuba/gpu/lang.js",
  "@tsuba/gpu/types.js",
]);

export function isMarkerModuleSpecifier(spec: string): boolean {
  return markerModuleSpecifiers.has(spec);
}

export function packageNameFromSpecifier(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  const idx = spec.indexOf("/");
  return idx === -1 ? spec : spec.slice(0, idx);
}

export function findNodeModulesPackageRoot(fromFileName: string, packageName: string): string | undefined {
  const packagePath = join("node_modules", ...packageName.split("/"));
  let cur = resolve(dirname(fromFileName));
  while (true) {
    const candidate = join(cur, packagePath);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

export function readBindingsManifest(
  path: string,
  specNode: ts.Node,
  deps: { readonly failAt: (node: ts.Node, code: string, message: string) => never }
): BindingsManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (e) {
    deps.failAt(specNode, "TSB3220", `Failed to read ${path}: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    deps.failAt(specNode, "TSB3221", `${path} must be a JSON object.`);
  }
  let manifest = parsed as Partial<BindingsManifest>;
  if (manifest.schema !== 1) {
    deps.failAt(specNode, "TSB3222", `${path}: unsupported schema (expected 1).`);
  }
  if (manifest.kind !== "crate") {
    deps.failAt(specNode, "TSB3223", `${path}: unsupported kind (expected "crate").`);
  }
  const crate = manifest.crate;
  if (!crate || typeof crate.name !== "string") {
    deps.failAt(specNode, "TSB3224", `${path}: missing crate.name.`);
  }
  if (crate.package !== undefined && typeof crate.package !== "string") {
    deps.failAt(specNode, "TSB3224", `${path}: crate.package must be a string when present.`);
  }
  const hasVersion = typeof crate.version === "string";
  const hasPath = typeof crate.path === "string";
  if (hasVersion && hasPath) {
    deps.failAt(specNode, "TSB3228", `${path}: crate must specify either version or path, not both.`);
  }
  if (!hasVersion && !hasPath) {
    deps.failAt(specNode, "TSB3224", `${path}: crate must specify either version or path.`);
  }
  if (hasPath) {
    const abs = normalizePath(resolve(dirname(path), crate.path!));
    manifest = { ...manifest, crate: { ...crate, path: abs } };
  }
  const features = (manifest.crate ?? crate).features;
  if (features !== undefined) {
    if (!Array.isArray(features) || !features.every((x) => typeof x === "string")) {
      deps.failAt(specNode, "TSB3227", `${path}: crate.features must be an array of strings when present.`);
    }
  }
  if (!manifest.modules || typeof manifest.modules !== "object") {
    deps.failAt(specNode, "TSB3225", `${path}: missing modules mapping.`);
  }
  return manifest as BindingsManifest;
}

export function resolveBindingsManifestPath(
  importSpecifier: string,
  fromFileName: string
): string | undefined {
  if (isMarkerModuleSpecifier(importSpecifier)) return undefined;
  if (importSpecifier.startsWith(".") || importSpecifier.startsWith("/")) return undefined;
  const packageName = packageNameFromSpecifier(importSpecifier);
  const packageRoot = findNodeModulesPackageRoot(fromFileName, packageName);
  if (!packageRoot) return undefined;
  return join(packageRoot, "tsuba.bindings.json");
}
