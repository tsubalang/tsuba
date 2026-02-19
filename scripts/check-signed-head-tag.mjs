#!/usr/bin/env node
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {
    root: undefined,
    ref: "HEAD",
    outPath: undefined,
    requireMode: false,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      out.root = argv[++i];
      continue;
    }
    if (arg === "--ref") {
      out.ref = argv[++i];
      continue;
    }
    if (arg === "--out" || arg === "--report") {
      out.outPath = argv[++i];
      continue;
    }
    if (arg === "--require") {
      out.requireMode = true;
      continue;
    }
    if (arg === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/check-signed-head-tag.mjs [options]",
          "",
          "Options:",
          "  --root <path>   Repository root (default: inferred from this script)",
          "  --ref <ref>     Git ref to inspect (default: HEAD)",
          "  --out <path>    JSON report output path (default: .tsuba/signed-tag.latest.json)",
          "  --require       Exit non-zero unless at least one signed tag points at ref",
          "  --pretty        Pretty-print report JSON",
          "  -h, --help      Show this help",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return out;
}

function runGit(root, command, allowFailure = false) {
  try {
    return execSync(`git ${command}`, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    if (allowFailure) return undefined;
    throw new Error(`Failed to run: git ${command}`);
  }
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function isSignedAnnotatedTag(root, tagName) {
  const objType = runGit(root, `cat-file -t refs/tags/${tagName}`, true);
  if (objType !== "tag") {
    return {
      tag: tagName,
      objectType: objType ?? "unknown",
      annotated: false,
      signed: false,
    };
  }
  const payload = runGit(root, `cat-file -p refs/tags/${tagName}`, true) ?? "";
  const signed =
    payload.includes("-----BEGIN PGP SIGNATURE-----") ||
    payload.includes("-----BEGIN SSH SIGNATURE-----");
  return {
    tag: tagName,
    objectType: objType,
    annotated: true,
    signed,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = fileURLToPath(import.meta.url);
  const root = resolve(args.root ?? join(dirname(here), ".."));
  const outPath = resolve(args.outPath ?? join(root, ".tsuba", "signed-tag.latest.json"));
  mkdirSync(dirname(outPath), { recursive: true });

  const commit = runGit(root, `rev-parse ${args.ref}`, true) ?? "UNKNOWN";
  const tagsRaw = runGit(root, `tag --points-at ${args.ref}`, true) ?? "";
  const tags = tagsRaw
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .sort((a, b) => a.localeCompare(b));
  const tagStates = tags.map((tag) => isSignedAnnotatedTag(root, tag));
  const signedTags = tagStates.filter((x) => x.signed).map((x) => x.tag);

  const report = {
    schema: 1,
    kind: "signed-tag-report",
    generatedAt: new Date().toISOString(),
    root: normalizePath(root),
    ref: args.ref,
    commit,
    tags: tagStates,
    summary: {
      tagCount: tags.length,
      signedTagCount: signedTags.length,
      hasSignedTag: signedTags.length > 0,
    },
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, args.pretty ? 2 : undefined)}\n`, "utf-8");
  process.stdout.write(
    [
      `Signed-tag report: ${outPath}`,
      `  ref=${args.ref} commit=${commit}`,
      `  tags=${tags.length} signed=${signedTags.length}`,
    ].join("\n") + "\n"
  );
  if (args.requireMode && signedTags.length === 0) {
    process.stdout.write("FAIL: no signed tags found at target ref.\n");
    process.exit(1);
  }
}

main();
