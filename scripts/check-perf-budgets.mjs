#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {
    metricsPath: undefined,
    budgetPath: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--metrics") {
      out.metricsPath = argv[++i];
      continue;
    }
    if (arg === "--budget") {
      out.budgetPath = argv[++i];
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        [
          "Usage: node scripts/check-perf-budgets.mjs [--metrics <path>] [--budget <path>]",
          "",
          "Validates E2E fixture runtime metrics against configured budgets.",
          "",
        ].join("\n")
      );
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function compareMetric(label, actual, max) {
  if (max === undefined) return undefined;
  if (actual <= max) return undefined;
  return `${label}: ${actual}ms exceeds budget ${max}ms`;
}

function main() {
  const here = fileURLToPath(import.meta.url);
  const root = resolve(join(dirname(here), ".."));
  const args = parseArgs(process.argv.slice(2));
  const metricsPath = resolve(args.metricsPath ?? join(root, "test", "fixtures", ".tsuba-e2e-metrics.json"));
  const budgetPath = resolve(args.budgetPath ?? join(root, "spec", "perf-budgets.json"));

  if (!existsSync(metricsPath)) {
    process.stdout.write(`SKIP: metrics file not found at ${metricsPath}\n`);
    process.exit(0);
  }
  if (!existsSync(budgetPath)) {
    process.stdout.write(`SKIP: budget file not found at ${budgetPath}\n`);
    process.exit(0);
  }

  const metrics = readJson(metricsPath);
  const budget = readJson(budgetPath);
  const projects = Array.isArray(metrics?.projects) ? metrics.projects : [];
  if (projects.length === 0) {
    process.stdout.write("SKIP: no project metrics to validate.\n");
    process.exit(0);
  }

  const defaultBudget = budget?.fixtureBudgets?.default ?? {};
  const fixtureBudgets = budget?.fixtureBudgets ?? {};
  const failures = [];

  for (const project of projects) {
    const fixtureName = typeof project?.fixture === "string" ? project.fixture : "<unknown>";
    const projectName = typeof project?.project === "string" ? project.project : "<unknown>";
    const specific = fixtureBudgets[fixtureName] ?? {};
    const mergedBudget = {
      maxBuildMs: asNumber(specific.maxBuildMs, asNumber(defaultBudget.maxBuildMs, undefined)),
      maxRunMs: asNumber(specific.maxRunMs, asNumber(defaultBudget.maxRunMs, undefined)),
      maxTestMs: asNumber(specific.maxTestMs, asNumber(defaultBudget.maxTestMs, undefined)),
      maxGoldenMs: asNumber(specific.maxGoldenMs, asNumber(defaultBudget.maxGoldenMs, undefined)),
      maxTotalMs: asNumber(specific.maxTotalMs, asNumber(defaultBudget.maxTotalMs, undefined)),
    };

    const checks = [
      compareMetric(`${fixtureName}/${projectName} build`, asNumber(project.buildMs, 0), mergedBudget.maxBuildMs),
      compareMetric(`${fixtureName}/${projectName} run`, asNumber(project.runMs, 0), mergedBudget.maxRunMs),
      compareMetric(`${fixtureName}/${projectName} test`, asNumber(project.testMs, 0), mergedBudget.maxTestMs),
      compareMetric(`${fixtureName}/${projectName} golden`, asNumber(project.goldenMs, 0), mergedBudget.maxGoldenMs),
      compareMetric(`${fixtureName}/${projectName} total`, asNumber(project.totalMs, 0), mergedBudget.maxTotalMs),
    ].filter((x) => x !== undefined);

    failures.push(...checks);
  }

  const maxSuiteTotal = asNumber(budget?.suiteBudgets?.maxE2eTotalMs, undefined);
  if (maxSuiteTotal !== undefined) {
    const e2eTotalMs = asNumber(metrics?.summary?.totalMs, 0);
    const suiteIssue = compareMetric("e2e-total", e2eTotalMs, maxSuiteTotal);
    if (suiteIssue) failures.push(suiteIssue);
  }

  if (failures.length > 0) {
    process.stdout.write("FAIL: performance budgets exceeded\n");
    for (const issue of failures) process.stdout.write(`  - ${issue}\n`);
    process.exit(1);
  }

  process.stdout.write(
    `PASS: performance budgets satisfied for ${projects.length} project metrics (summary total ${asNumber(metrics?.summary?.totalMs, 0)}ms)\n`
  );
}

main();
