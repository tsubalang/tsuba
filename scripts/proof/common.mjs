#!/usr/bin/env node
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

export function repoRootFrom(importMetaUrl) {
  const here = fileURLToPath(importMetaUrl);
  return resolve(join(dirname(here), "../.."));
}

export function makeTempWorkspace(rootDir, name) {
  const base = join(rootDir, ".tsuba", "proof");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${name}-`));
}

export function copyTemplate(src, dst) {
  cpSync(src, dst, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (entry) => {
      const base = entry.split(/[\\/]/g).at(-1) ?? entry;
      if (base === ".git" || base === "node_modules" || base === ".tsuba") return false;
      if (base === "generated") return false;
      if (base === "Cargo.lock") return false;
      if (base.startsWith(".tsuba-e2e-")) return false;
      return true;
    },
  });
}

export function collectTsStats(rootDir) {
  const out = { files: 0, lines: 0 };
  const recurse = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name === ".git" || name === "node_modules" || name === ".tsuba" || name === "generated") continue;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        recurse(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!name.endsWith(".ts")) continue;
      out.files += 1;
      const text = readFileSync(full, "utf-8");
      out.lines += text.split(/\r?\n/g).length;
    }
  };
  recurse(rootDir);
  return out;
}

export function runChecked(command, args, cwd, label) {
  const res = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    const detail = [
      `${label} failed: ${command} ${args.join(" ")}`,
      `cwd: ${cwd}`,
      "--- stdout ---",
      res.stdout ?? "",
      "--- stderr ---",
      res.stderr ?? "",
    ].join("\n");
    throw new Error(detail);
  }
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function findCliBin(rootDir) {
  return join(rootDir, "packages", "cli", "dist", "bin.js");
}

export function writeProofReport(rootDir, name, payload) {
  const reportsDir = join(rootDir, ".tsuba", "proof-reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${name}.json`);
  writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return normalizePath(reportPath);
}

export function cleanupTemp(path) {
  rmSync(path, { recursive: true, force: true });
}
