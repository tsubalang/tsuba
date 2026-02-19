#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {
    root: undefined,
    baselinePath: undefined,
    reportPath: undefined,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = argv[++i];
      continue;
    }
    if (arg === "--baseline") {
      args.baselinePath = argv[++i];
      continue;
    }
    if (arg === "--report") {
      args.reportPath = argv[++i];
      continue;
    }
    if (arg === "--pretty") {
      args.pretty = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/check-diagnostic-quality.mjs [options]",
          "",
          "Options:",
          "  --root <path>      Repository root (default: inferred from this script)",
          "  --baseline <path>  Baseline JSON path (default: spec/diagnostic-quality-baseline.json)",
          "  --report <path>    Report output path (default: .tsuba/diagnostic-quality.latest.json)",
          "  --pretty           Pretty-print report JSON",
          "  -h, --help         Show this help",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return args;
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function countRegexMatches(text, regex) {
  const matches = text.match(regex);
  return Array.isArray(matches) ? matches.length : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const here = fileURLToPath(import.meta.url);
  const inferredRoot = resolve(join(dirname(here), ".."));
  const root = resolve(parsed.root ?? inferredRoot);

  const baselinePath = resolve(parsed.baselinePath ?? join(root, "spec", "diagnostic-quality-baseline.json"));
  const reportPath = resolve(parsed.reportPath ?? join(root, ".tsuba", "diagnostic-quality.latest.json"));
  mkdirSync(dirname(reportPath), { recursive: true });

  const diagnosticsTsPath = join(root, "packages", "compiler", "src", "rust", "diagnostics.ts");
  const diagnosticsFixtureDir = join(root, "packages", "compiler", "testdata", "diagnostics");
  const diagnosticTestFiles = [
    "packages/compiler/src/rust/diagnostic-fixtures.test.ts",
    "packages/compiler/src/rust/diagnostic-matrix.test.ts",
    "packages/compiler/src/rust/diagnostic-normalization.test.ts",
    "packages/compiler/src/rust/function-semantics-matrix.test.ts",
    "packages/compiler/src/rust/risk-regressions.test.ts",
    "packages/compiler/src/rust/supported-syntax-matrix.test.ts",
    "packages/compiler/src/rust/unsupported-syntax-matrix.test.ts",
  ].map((rel) => join(root, rel));

  const diagnosticsSource = existsSync(diagnosticsTsPath) ? readFileSync(diagnosticsTsPath, "utf-8") : "";
  const codeMatches = diagnosticsSource.match(/\bTSB\d{4}\b/g) ?? [];
  const diagnosticCodeCount = uniqueSorted(codeMatches).length;

  const fixtureFiles = walkFiles(diagnosticsFixtureDir)
    .filter((path) => path.endsWith(".ts"))
    .map((path) => normalizePath(path));

  let matrixTestCaseCount = 0;
  for (const file of diagnosticTestFiles) {
    if (!existsSync(file)) continue;
    matrixTestCaseCount += countRegexMatches(readFileSync(file, "utf-8"), /\bit\(/g);
  }

  const metrics = {
    diagnosticCodeCount,
    fixtureFileCount: fixtureFiles.length,
    matrixTestCaseCount,
  };

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf-8"))
    : undefined;
  const minimums = baseline?.minimums ?? {};

  const failures = [];
  const checks = [
    ["diagnosticCodeCount", asNumber(minimums.diagnosticCodeCount, 0)],
    ["fixtureFileCount", asNumber(minimums.fixtureFileCount, 0)],
    ["matrixTestCaseCount", asNumber(minimums.matrixTestCaseCount, 0)],
  ];
  for (const [name, min] of checks) {
    const actual = asNumber(metrics[name], 0);
    if (actual < min) {
      failures.push(`${name}: expected >= ${min}, got ${actual}`);
    }
  }

  const report = {
    schema: 1,
    kind: "diagnostic-quality-report",
    generatedAt: new Date().toISOString(),
    baselinePath: normalizePath(baselinePath),
    metrics,
    minimums: {
      diagnosticCodeCount: asNumber(minimums.diagnosticCodeCount, 0),
      fixtureFileCount: asNumber(minimums.fixtureFileCount, 0),
      matrixTestCaseCount: asNumber(minimums.matrixTestCaseCount, 0),
    },
    fixtureFiles,
    status: failures.length === 0 ? "passed" : "failed",
    failures,
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, parsed.pretty ? 2 : undefined)}\n`, "utf-8");
  if (failures.length === 0) {
    process.stdout.write(
      `PASS: diagnostic quality baseline satisfied (codes=${metrics.diagnosticCodeCount}, fixtures=${metrics.fixtureFileCount}, matrixTests=${metrics.matrixTestCaseCount})\n`
    );
    return;
  }

  process.stdout.write(`FAIL: diagnostic quality baseline check failed\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.exit(1);
}

main();
