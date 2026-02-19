#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function readGit(root, command, allowFailure = false) {
  try {
    return execSync(`git ${command}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }).trim();
  } catch {
    if (allowFailure) return undefined;
    throw new Error(`Failed to run: git ${command}`);
  }
}

function parseArgs(argv) {
  let outPath;
  let pretty = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--out") {
      i++;
      if (!argv[i]) throw new Error("--out requires a file path");
      outPath = resolve(argv[i]);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/release-traceability.mjs [--pretty] [--out <path>]",
          "",
          "Produces a deterministic release-traceability JSON report containing:",
          "- git commit/branch/sync status",
          "- publishable npm package versions",
          "- crate versions from Cargo manifests",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outPath, pretty };
}

function parseCargoPackage(manifestPath) {
  const text = readFileSync(manifestPath, "utf-8");
  const lines = text.split(/\r?\n/g);
  let inPackage = false;
  let name;
  let version;
  let publish = true;
  for (const line0 of lines) {
    const line = line0.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inPackage = line === "[package]";
      continue;
    }
    if (!inPackage || line.length === 0 || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (key === "name") {
      const match = /^["'](.+)["']$/.exec(raw);
      if (match) name = match[1];
      continue;
    }
    if (key === "version") {
      const match = /^["'](.+)["']$/.exec(raw);
      if (match) version = match[1];
      continue;
    }
    if (key === "publish") {
      if (raw === "false") publish = false;
      if (raw === "true") publish = true;
    }
  }
  if (!name || !version) {
    throw new Error(`Could not parse [package] name/version in ${manifestPath}`);
  }
  return { name, version, publish };
}

function collectNpmPackages(root) {
  const packagesRoot = join(root, "packages");
  const entries = readdirSync(packagesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const out = [];
  for (const entry of entries) {
    const packageJsonPath = join(packagesRoot, entry.name, "package.json");
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (parsed.private === true) continue;
      if (typeof parsed.name !== "string" || typeof parsed.version !== "string") continue;
      out.push({
        name: parsed.name,
        version: parsed.version,
        path: normalizePath(relative(root, packageJsonPath)),
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.name === b.name ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.name < b.name ? -1 : 1));
  return out;
}

function collectCrates(root) {
  const stack = [root];
  const manifests = [];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".tsuba") continue;
      const abs = join(dir, entry.name);
      const rel = normalizePath(relative(root, abs));
      if (rel.startsWith("test/fixtures")) continue;
      stack.push(abs);
    }
    const manifestPath = join(dir, "Cargo.toml");
    try {
      const pkg = parseCargoPackage(manifestPath);
      manifests.push({
        name: pkg.name,
        version: pkg.version,
        publish: pkg.publish,
        manifestPath: normalizePath(relative(root, manifestPath)),
      });
    } catch {
      continue;
    }
  }
  manifests.sort((a, b) =>
    a.name === b.name
      ? a.manifestPath < b.manifestPath
        ? -1
        : a.manifestPath > b.manifestPath
          ? 1
          : 0
      : a.name < b.name
        ? -1
        : 1
  );
  return manifests;
}

function main() {
  const here = fileURLToPath(import.meta.url);
  const root = resolve(join(dirname(here), ".."));
  const { outPath, pretty } = parseArgs(process.argv.slice(2));

  const gitBranch = readGit(root, "rev-parse --abbrev-ref HEAD", true) ?? "UNKNOWN";
  const gitCommit = readGit(root, "rev-parse HEAD", true) ?? "UNKNOWN";
  const gitCommitShort = gitCommit === "UNKNOWN" ? "UNKNOWN" : gitCommit.slice(0, 12);
  const gitOriginMain = readGit(root, "rev-parse --verify origin/main", true);
  const gitDirty = (readGit(root, "status --porcelain --untracked-files=all", true) ?? "").length > 0;

  const report = {
    schema: 1,
    kind: "release-traceability",
    git: {
      branch: gitBranch,
      commit: gitCommit,
      commitShort: gitCommitShort,
      originMain: gitOriginMain,
      dirty: gitDirty,
      inSyncWithOriginMain: gitOriginMain ? gitCommit === gitOriginMain : undefined,
    },
    npmPackages: collectNpmPackages(root),
    crates: collectCrates(root),
  };

  const text = JSON.stringify(report, null, pretty ? 2 : undefined);
  if (outPath) {
    writeFileSync(outPath, `${text}\n`, "utf-8");
  } else {
    process.stdout.write(`${text}\n`);
  }
}

main();
