#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {
    root: undefined,
    configPath: undefined,
    reportPath: undefined,
    requireMode: false,
    pretty: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = argv[++i];
      continue;
    }
    if (arg === "--config") {
      args.configPath = argv[++i];
      continue;
    }
    if (arg === "--report") {
      args.reportPath = argv[++i];
      continue;
    }
    if (arg === "--require") {
      args.requireMode = true;
      continue;
    }
    if (arg === "--pretty") {
      args.pretty = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/verify-external-proof.mjs [options]",
          "",
          "Options:",
          "  --root <path>      Repository root (default: inferred from this script)",
          "  --config <path>    External proof matrix config (default: spec/external-proof-matrix.json)",
          "  --report <path>    JSON report output path (default: .tsuba/external-proof.latest.json)",
          "  --require          Enforce required checks/categories/substantial-count",
          "  --pretty           Pretty-print report JSON",
          "  -h, --help         Show this help",
          "",
          "Behavior:",
          "  - Missing repo/check scripts are SKIP unless --require and check.required=true.",
          "  - Executed checks that fail always fail this command.",
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

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value, dflt = false) {
  return typeof value === "boolean" ? value : dflt;
}

function asNumber(value, dflt = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : dflt;
}

function nowMs() {
  return Date.now();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function runCheck(rootDir, check, logsDir) {
  const id = asString(check?.id);
  const repoRaw = asString(check?.repo);
  const command = toArray(check?.command);
  const cwdRaw = asString(check?.cwd) ?? ".";
  const categories = toArray(check?.categories)
    .map((x) => asString(x))
    .filter((x) => typeof x === "string");
  const substantial = asBoolean(check?.substantial, false);
  const required = asBoolean(check?.required, true);

  if (!id || !repoRaw || command.length === 0 || command.some((x) => typeof x !== "string")) {
    return {
      id: id ?? "<invalid>",
      status: "invalid",
      required,
      substantial,
      categories,
      message: "invalid check entry (requires id/repo/command[])",
      durationMs: 0,
    };
  }
  const commandName = command[0];
  const commandArgs = command.slice(1);

  const repoAbs = isAbsolute(repoRaw) ? repoRaw : resolve(join(rootDir, repoRaw));
  if (!existsSync(repoAbs)) {
    return {
      id,
      status: "missing",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      message: `repo not found: ${repoAbs}`,
      durationMs: 0,
    };
  }

  const cwdAbs = resolve(join(repoAbs, cwdRaw));
  if (!existsSync(cwdAbs)) {
    return {
      id,
      status: "missing",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      cwd: normalizePath(cwdAbs),
      message: `cwd not found: ${cwdAbs}`,
      durationMs: 0,
    };
  }

  if (commandNameLooksLikePath(commandName) && !existsSync(resolve(join(cwdAbs, commandName)))) {
    return {
      id,
      status: "missing",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      cwd: normalizePath(cwdAbs),
      message: `command path not found: ${commandName}`,
      durationMs: 0,
    };
  }
  if (
    (commandName === "bash" || commandName === "sh") &&
    commandArgs.length > 0 &&
    commandNameLooksLikePath(commandArgs[0]) &&
    !existsSync(resolve(join(cwdAbs, commandArgs[0])))
  ) {
    return {
      id,
      status: "missing",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      cwd: normalizePath(cwdAbs),
      message: `script path not found: ${commandArgs[0]}`,
      durationMs: 0,
    };
  }

  const start = nowMs();
  const outcome = spawnSync(commandName, commandArgs, {
    cwd: cwdAbs,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const durationMs = nowMs() - start;

  const logPath = join(logsDir, `${id}.log`);
  const stdout = outcome.stdout ?? "";
  const stderr = outcome.stderr ?? "";
  writeFileSync(
    logPath,
    [
      `# check: ${id}`,
      `# cwd: ${cwdAbs}`,
      `# command: ${commandName} ${commandArgs.join(" ")}`.trimEnd(),
      `# exit: ${outcome.status ?? "null"} signal=${outcome.signal ?? "none"}`,
      "",
      "## stdout",
      stdout,
      "",
      "## stderr",
      stderr,
      "",
    ].join("\n"),
    "utf-8"
  );

  if (outcome.error) {
    if (outcome.error?.code === "ENOENT") {
      return {
        id,
        status: "missing",
        required,
        substantial,
        categories,
        repoPath: normalizePath(repoAbs),
        cwd: normalizePath(cwdAbs),
        durationMs,
        logPath: normalizePath(logPath),
        message: `command not found: ${commandName}`,
        exitCode: null,
        signal: outcome.signal ?? null,
      };
    }
    return {
      id,
      status: "failed",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      cwd: normalizePath(cwdAbs),
      durationMs,
      logPath: normalizePath(logPath),
      message: String(outcome.error),
      exitCode: null,
      signal: outcome.signal ?? null,
    };
  }

  if (outcome.status !== 0) {
    return {
      id,
      status: "failed",
      required,
      substantial,
      categories,
      repoPath: normalizePath(repoAbs),
      cwd: normalizePath(cwdAbs),
      durationMs,
      logPath: normalizePath(logPath),
      message: `command failed with exit code ${String(outcome.status)}`,
      exitCode: outcome.status,
      signal: outcome.signal ?? null,
    };
  }

  return {
    id,
    status: "passed",
    required,
    substantial,
    categories,
    repoPath: normalizePath(repoAbs),
    cwd: normalizePath(cwdAbs),
    durationMs,
    logPath: normalizePath(logPath),
    exitCode: outcome.status,
    signal: outcome.signal ?? null,
  };
}

function commandNameLooksLikePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) return true;
  return value.includes("/");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const here = fileURLToPath(import.meta.url);
  const inferredRoot = resolve(join(dirname(here), ".."));
  const rootDir = resolve(parsed.root ?? inferredRoot);

  const configPath = resolve(parsed.configPath ?? join(rootDir, "spec", "external-proof-matrix.json"));
  const reportPath = resolve(parsed.reportPath ?? join(rootDir, ".tsuba", "external-proof.latest.json"));
  mkdirSync(dirname(reportPath), { recursive: true });
  const logsDir = join(dirname(reportPath), "external-proof-logs");
  mkdirSync(logsDir, { recursive: true });

  if (!existsSync(configPath)) {
    const report = {
      schema: 1,
      kind: "external-proof-report",
      generatedAt: new Date().toISOString(),
      configPath: normalizePath(configPath),
      mode: parsed.requireMode ? "require" : "best-effort",
      status: "skipped",
      message: "config file not found",
      checks: [],
      summary: {
        passed: 0,
        failed: 0,
        missing: 0,
        invalid: 0,
        totalDurationMs: 0,
        substantialPassed: 0,
      },
      requiredCategories: [],
      coveredCategories: [],
      missingCategories: [],
      minimumPassingSubstantial: 0,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, parsed.pretty ? 2 : undefined)}\n`, "utf-8");
    process.stdout.write(`SKIP: external proof config not found at ${configPath}\n`);
    if (parsed.requireMode) {
      process.stdout.write("FAIL: --require was set.\n");
      process.exit(1);
    }
    process.exit(0);
  }

  const config = readJson(configPath);
  if (config?.schema !== 1 || config?.kind !== "external-proof-matrix") {
    throw new Error(`Invalid external-proof-matrix config at ${configPath}`);
  }

  const requiredCategories = toArray(config.requiredCategories)
    .map((x) => asString(x))
    .filter((x) => typeof x === "string")
    .sort((a, b) => a.localeCompare(b));
  const minimumPassingSubstantial = Math.max(0, Math.trunc(asNumber(config.minimumPassingSubstantial, 0)));
  const checks = toArray(config.checks)
    .slice()
    .sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));

  const checkResults = checks.map((check) => runCheck(rootDir, check, logsDir));

  let passed = 0;
  let failed = 0;
  let missing = 0;
  let invalid = 0;
  let substantialPassed = 0;
  let totalDurationMs = 0;
  const coveredCategoriesSet = new Set();
  const failures = [];

  for (const result of checkResults) {
    totalDurationMs += asNumber(result.durationMs, 0);
    if (result.status === "passed") {
      passed++;
      if (result.substantial) substantialPassed++;
      for (const category of result.categories ?? []) coveredCategoriesSet.add(category);
      continue;
    }
    if (result.status === "failed") {
      failed++;
      failures.push(`${result.id}: ${result.message ?? "failed"}`);
      continue;
    }
    if (result.status === "missing") {
      missing++;
      if (parsed.requireMode && result.required) {
        failures.push(`${result.id}: ${result.message ?? "missing required external proof target"}`);
      }
      continue;
    }
    if (result.status === "invalid") {
      invalid++;
      failures.push(`${result.id}: ${result.message ?? "invalid entry"}`);
      continue;
    }
  }

  const coveredCategories = [...coveredCategoriesSet].sort((a, b) => a.localeCompare(b));
  const missingCategories = requiredCategories.filter((x) => !coveredCategoriesSet.has(x));

  if (parsed.requireMode) {
    if (minimumPassingSubstantial > 0 && substantialPassed < minimumPassingSubstantial) {
      failures.push(
        `substantial checks: passed ${substantialPassed}, require at least ${minimumPassingSubstantial}`
      );
    }
    if (missingCategories.length > 0) {
      failures.push(`missing required categories: ${missingCategories.join(", ")}`);
    }
  }

  const status = failures.length > 0 || failed > 0 ? "failed" : "passed";
  const report = {
    schema: 1,
    kind: "external-proof-report",
    generatedAt: new Date().toISOString(),
    configPath: normalizePath(configPath),
    reportPath: normalizePath(reportPath),
    mode: parsed.requireMode ? "require" : "best-effort",
    status,
    checks: checkResults,
    summary: {
      passed,
      failed,
      missing,
      invalid,
      totalDurationMs,
      substantialPassed,
    },
    requiredCategories,
    coveredCategories,
    missingCategories,
    minimumPassingSubstantial,
    failures,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, parsed.pretty ? 2 : undefined)}\n`, "utf-8");

  process.stdout.write(
    [
      `External proof report: ${reportPath}`,
      `  mode=${report.mode} status=${report.status}`,
      `  checks: passed=${passed}, failed=${failed}, missing=${missing}, invalid=${invalid}`,
      `  categories: covered=${coveredCategories.length}/${requiredCategories.length}`,
      `  substantial: passed=${substantialPassed}, min=${minimumPassingSubstantial}`,
    ].join("\n") + "\n"
  );
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  }

  if (status !== "passed") process.exit(1);
}

main();
