#!/usr/bin/env bash
# E2E fixture runner.
#
# Current behavior:
# - discovers workspace-style fixtures under test/fixtures
# - verifies they support `tsuba build` in place
# - optional per-fixture `e2e.meta.json` controls `run` / `test` steps,
#   expected run-output substrings, and Rust golden snapshot checks
#
# This script intentionally stays explicit and deterministic:
# build, run/test, and golden checks all happen from fixture metadata.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_DIR="$ROOT_DIR/test/fixtures"
METRICS_FILE="$FIXTURES_DIR/.tsuba-e2e-metrics.json"

FILTER_PATTERNS=()

print_help() {
  cat <<'EOF_HELP'
Usage: ./test/scripts/run-e2e.sh [--filter <pattern>]

Options:
  --filter <pattern>   Only run fixtures whose directory name contains <pattern>.
                       Can be repeated, or comma-separated.
  Fixture metadata:
    e2e.meta.json:
      { "run": true, "test": true, "runStdoutContains": ["hello"] }
  -h, --help           Show this help.
EOF_HELP
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --filter)
      shift
      if [ -z "${1:-}" ]; then
        echo "FAIL: --filter requires a value"
        exit 2
      fi
      FILTER_PATTERNS+=("$1")
      shift
      ;;
    --filter=*)
      FILTER_PATTERNS+=("${1#*=}")
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "FAIL: unknown arg: $1"
      print_help
      exit 2
      ;;
  esac
done

matches_filter() {
  local name="$1"
  if [ ${#FILTER_PATTERNS[@]} -eq 0 ]; then
    return 0
  fi

  local raw
  for raw in "${FILTER_PATTERNS[@]}"; do
    local IFS=','
    local -a parts
    read -ra parts <<<"$raw"
    local pat
    for pat in "${parts[@]}"; do
      [ -n "$pat" ] || continue
      if [[ "$name" == *"$pat"* ]]; then
        return 0
      fi
    done
  done
  return 1
}

json_get_bool() {
  local file="$1"
  local key="$2"
  local default_value="$3"
  if [ ! -f "$file" ]; then
    printf "%s" "$default_value"
    return 0
  fi
  node -e '
const fs = require("node:fs");
const [file, key, dflt] = process.argv.slice(1);
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = parsed?.[key];
  if (typeof value === "boolean") {
    process.stdout.write(value ? "true" : "false");
  } else {
    process.stdout.write(dflt);
  }
} catch {
  process.stdout.write(dflt);
}
' "$file" "$key" "$default_value"
}

json_get_string_array_lines() {
  local file="$1"
  local key="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  node -e '
const fs = require("node:fs");
const [file, key] = process.argv.slice(1);
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = parsed?.[key];
  if (!Array.isArray(value)) process.exit(0);
  for (const item of value) {
    if (typeof item === "string") process.stdout.write(`${item}\n`);
  }
} catch {
  process.exit(0);
}
' "$file" "$key"
}

json_get_string() {
  local file="$1"
  local key="$2"
  local default_value="$3"
  if [ ! -f "$file" ]; then
    printf "%s" "$default_value"
    return 0
  fi
  node -e '
const fs = require("node:fs");
const [file, key, dflt] = process.argv.slice(1);
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = parsed?.[key];
  if (typeof value === "string") {
    process.stdout.write(value);
  } else {
    process.stdout.write(dflt);
  }
} catch {
  process.stdout.write(dflt);
}
' "$file" "$key" "$default_value"
}

json_get_object_value() {
  local file="$1"
  local object_key="$2"
  local prop_key="$3"
  if [ ! -f "$file" ]; then
    return 0
  fi
  node -e '
const fs = require("node:fs");
const [file, objectKey, propKey] = process.argv.slice(1);
try {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const obj = parsed?.[objectKey];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) process.exit(0);
  const value = obj[propKey];
  if (typeof value === "string") process.stdout.write(value);
} catch {
  process.exit(0);
}
' "$file" "$object_key" "$prop_key"
}

normalize_main_rs_for_golden() {
  local input_file="$1"
  local output_file="$2"
  sed -E 's#(// tsuba-span: ).*:([0-9]+):([0-9]+)$#\1<SOURCE>:\2:\3#' "$input_file" >"$output_file"
}

now_ms() {
  date +%s%3N
}

if [ ! -d "$FIXTURES_DIR" ]; then
  echo "No fixture directory found at $FIXTURES_DIR. Nothing to run."
  exit 0
fi

cli_bin="$ROOT_DIR/packages/cli/dist/bin.js"
if [ ! -f "$cli_bin" ]; then
  echo "E2E fixture runner requires built CLI. Run npm run -w @tsuba/cli build."
  exit 1
fi

passed=0
skipped=0
failed=0
run_any=false

mkdir -p "$ROOT_DIR/.tsuba"
metrics_tsv="$(mktemp "$ROOT_DIR/.tsuba/e2e-metrics-XXXXXX.tsv")"
trap 'rm -f "$metrics_tsv"' EXIT
printf 'fixture\tproject\tbuildMs\trunMs\ttestMs\tgoldenMs\ttotalMs\n' >"$metrics_tsv"

echo "=== E2E fixtures ==="
if [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Filter: ${FILTER_PATTERNS[*]}"
fi

for fixture_dir in "$FIXTURES_DIR"/*/; do
  [ -d "$fixture_dir" ] || continue
  fixture_name="$(basename "$fixture_dir")"
  if ! matches_filter "$fixture_name"; then
    continue
  fi
  run_any=true

  meta_file="$fixture_dir/e2e.meta.json"
  fixture_expect_failure="$(json_get_bool "$meta_file" "expectFailure" "false")"
  if [ "$fixture_expect_failure" = "true" ]; then
    echo "  $fixture_name: SKIP (expectFailure)"
    skipped=$((skipped + 1))
    continue
  fi
  fixture_run="$(json_get_bool "$meta_file" "run" "false")"
  fixture_test="$(json_get_bool "$meta_file" "test" "false")"
  fixture_golden_main_rs="$(json_get_string "$meta_file" "goldenMainRs" "")"
  mapfile -t run_stdout_contains < <(json_get_string_array_lines "$meta_file" "runStdoutContains")
  generated_dir_name="$(json_get_string "$fixture_dir/tsuba.workspace.json" "generatedDirName" "generated")"

  if [ ! -f "$fixture_dir/tsuba.workspace.json" ]; then
    echo "  $fixture_name: SKIP (missing tsuba.workspace.json)"
    skipped=$((skipped + 1))
    continue
  fi

  # Find candidate project directories.
  project_dirs=()
  if [ -d "$fixture_dir/packages" ]; then
    while IFS= read -r -d '' p; do
      [ -f "$p/tsuba.json" ] && project_dirs+=("$p")
    done < <(find "$fixture_dir/packages" -mindepth 1 -maxdepth 1 -type d -print0)
  fi

  if [ ${#project_dirs[@]} -eq 0 ] && [ -f "$fixture_dir/tsuba.json" ]; then
    project_dirs+=("$fixture_dir")
  fi

  if [ ${#project_dirs[@]} -eq 0 ]; then
    echo "  $fixture_name: SKIP (no project with tsuba.json)"
    skipped=$((skipped + 1))
    continue
  fi

  fixture_failed=false
  for project_dir in "${project_dirs[@]}"; do
    project_name="$(basename "$project_dir")"
    build_ms=0
    run_ms=0
    test_ms=0
    golden_ms=0
    echo "  $fixture_name/$project_name: BUILD"
    build_start="$(now_ms)"
    if (cd "$project_dir" && node "$cli_bin" build) >"$project_dir/.tsuba-e2e-build.log" 2>&1; then
      build_end="$(now_ms)"
      build_ms=$((build_end - build_start))
      :
    else
      build_end="$(now_ms)"
      build_ms=$((build_end - build_start))
      fixture_failed=true
      failed=$((failed + 1))
      echo "  $fixture_name/$project_name: FAIL"
      sed -n '1,200p' "$project_dir/.tsuba-e2e-build.log"
      total_ms=$((build_ms + run_ms + test_ms + golden_ms))
      printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
        "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
      break
    fi

    if [ "$fixture_run" = "true" ]; then
      echo "  $fixture_name/$project_name: RUN"
      run_start="$(now_ms)"
      if (cd "$project_dir" && node "$cli_bin" run) >"$project_dir/.tsuba-e2e-run.log" 2>&1; then
        run_end="$(now_ms)"
        run_ms=$((run_end - run_start))
        :
      else
        run_end="$(now_ms)"
        run_ms=$((run_end - run_start))
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (run)"
        sed -n '1,200p' "$project_dir/.tsuba-e2e-run.log"
        total_ms=$((build_ms + run_ms + test_ms + golden_ms))
        printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
          "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
        break
      fi

      if [ ${#run_stdout_contains[@]} -gt 0 ]; then
        for expected in "${run_stdout_contains[@]}"; do
          if ! grep -Fq -- "$expected" "$project_dir/.tsuba-e2e-run.log"; then
            fixture_failed=true
            failed=$((failed + 1))
            echo "  $fixture_name/$project_name: FAIL (run output)"
            echo "    missing expected substring: $expected"
            sed -n '1,200p' "$project_dir/.tsuba-e2e-run.log"
            total_ms=$((build_ms + run_ms + test_ms + golden_ms))
            printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
              "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
            break 2
          fi
        done
      fi
    fi

    if [ "$fixture_test" = "true" ]; then
      echo "  $fixture_name/$project_name: TEST"
      test_start="$(now_ms)"
      if (cd "$project_dir" && node "$cli_bin" test) >"$project_dir/.tsuba-e2e-test.log" 2>&1; then
        test_end="$(now_ms)"
        test_ms=$((test_end - test_start))
        :
      else
        test_end="$(now_ms)"
        test_ms=$((test_end - test_start))
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (test)"
        sed -n '1,200p' "$project_dir/.tsuba-e2e-test.log"
        total_ms=$((build_ms + run_ms + test_ms + golden_ms))
        printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
          "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
        break
      fi
    fi

    fixture_project_golden_main_rs="$(json_get_object_value "$meta_file" "goldenMainRsByProject" "$project_name")"
    golden_main_rs_path="$fixture_project_golden_main_rs"
    if [ -z "$golden_main_rs_path" ]; then
      golden_main_rs_path="$fixture_golden_main_rs"
    fi
    if [ -n "$golden_main_rs_path" ]; then
      expected_main_rs="$fixture_dir/$golden_main_rs_path"
      generated_main_rs="$project_dir/$generated_dir_name/src/main.rs"
      echo "  $fixture_name/$project_name: GOLDEN"
      golden_start="$(now_ms)"
      if [ ! -f "$expected_main_rs" ]; then
        golden_end="$(now_ms)"
        golden_ms=$((golden_end - golden_start))
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (missing golden)"
        echo "    expected golden path: $expected_main_rs"
        total_ms=$((build_ms + run_ms + test_ms + golden_ms))
        printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
          "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
        break
      fi
      if [ ! -f "$generated_main_rs" ]; then
        golden_end="$(now_ms)"
        golden_ms=$((golden_end - golden_start))
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (missing generated main.rs)"
        echo "    generated path: $generated_main_rs"
        total_ms=$((build_ms + run_ms + test_ms + golden_ms))
        printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
          "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
        break
      fi
      if diff -u "$expected_main_rs" "$generated_main_rs" >"$project_dir/.tsuba-e2e-golden.diff"; then
        golden_end="$(now_ms)"
        golden_ms=$((golden_end - golden_start))
        :
      else
        normalized_expected="$project_dir/.tsuba-e2e-golden.expected.norm"
        normalized_generated="$project_dir/.tsuba-e2e-golden.generated.norm"
        normalize_main_rs_for_golden "$expected_main_rs" "$normalized_expected"
        normalize_main_rs_for_golden "$generated_main_rs" "$normalized_generated"
        if diff -u "$normalized_expected" "$normalized_generated" >"$project_dir/.tsuba-e2e-golden.diff"; then
          golden_end="$(now_ms)"
          golden_ms=$((golden_end - golden_start))
          :
        else
          golden_end="$(now_ms)"
          golden_ms=$((golden_end - golden_start))
          fixture_failed=true
          failed=$((failed + 1))
          echo "  $fixture_name/$project_name: FAIL (golden mismatch)"
          sed -n '1,200p' "$project_dir/.tsuba-e2e-golden.diff"
          total_ms=$((build_ms + run_ms + test_ms + golden_ms))
          printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
            "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
          break
        fi
      fi
    fi

    total_ms=$((build_ms + run_ms + test_ms + golden_ms))
    printf '%s\t%s\t%d\t%d\t%d\t%d\t%d\n' \
      "$fixture_name" "$project_name" "$build_ms" "$run_ms" "$test_ms" "$golden_ms" "$total_ms" >>"$metrics_tsv"
  done

  if [ "$fixture_failed" = true ]; then
    continue
  fi

  echo "  $fixture_name: PASS"
  passed=$((passed + 1))
done

if [ "$run_any" = false ]; then
  echo "E2E summary: 0 passed, 0 skipped, 0 failed"
  exit 0
fi

node -e '
const fs = require("node:fs");
const [tsvPath, outPath] = process.argv.slice(1);
const text = fs.readFileSync(tsvPath, "utf8").trim();
const lines = text.length === 0 ? [] : text.split(/\r?\n/g);
const rows = lines.slice(1).map((line) => {
  const [fixture, project, buildMs, runMs, testMs, goldenMs, totalMs] = line.split("\t");
  return {
    fixture,
    project,
    buildMs: Number.parseInt(buildMs, 10) || 0,
    runMs: Number.parseInt(runMs, 10) || 0,
    testMs: Number.parseInt(testMs, 10) || 0,
    goldenMs: Number.parseInt(goldenMs, 10) || 0,
    totalMs: Number.parseInt(totalMs, 10) || 0,
  };
});
const byFixture = new Map();
for (const row of rows) {
  const prev = byFixture.get(row.fixture) ?? { projects: 0, totalMs: 0, buildMs: 0, runMs: 0, testMs: 0, goldenMs: 0 };
  prev.projects += 1;
  prev.totalMs += row.totalMs;
  prev.buildMs += row.buildMs;
  prev.runMs += row.runMs;
  prev.testMs += row.testMs;
  prev.goldenMs += row.goldenMs;
  byFixture.set(row.fixture, prev);
}
const fixtures = [...byFixture.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([fixture, summary]) => ({ fixture, ...summary }));
const summary = rows.reduce(
  (acc, row) => {
    acc.projects += 1;
    acc.totalMs += row.totalMs;
    acc.buildMs += row.buildMs;
    acc.runMs += row.runMs;
    acc.testMs += row.testMs;
    acc.goldenMs += row.goldenMs;
    return acc;
  },
  { projects: 0, totalMs: 0, buildMs: 0, runMs: 0, testMs: 0, goldenMs: 0 }
);
const report = {
  schema: 1,
  kind: "e2e-metrics",
  generatedAt: new Date().toISOString(),
  projects: rows,
  fixtures,
  summary,
};
fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
' "$metrics_tsv" "$METRICS_FILE"
echo "E2E metrics: $METRICS_FILE"

echo ""
echo "E2E summary: $passed passed, $skipped skipped, $failed failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
