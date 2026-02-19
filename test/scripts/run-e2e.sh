#!/usr/bin/env bash
# E2E fixture runner.
#
# Current behavior:
# - discovers workspace-style fixtures under test/fixtures
# - verifies they support `tsuba build` in place
# - optional per-fixture `e2e.meta.json` controls `run` / `test` steps and
#   expected run-output substrings
#
# This script is intentionally minimal while the E2E corpus is small.
# Future phases can expand it with runtime execution checks and artifact validation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_DIR="$ROOT_DIR/test/fixtures"

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
  mapfile -t run_stdout_contains < <(json_get_string_array_lines "$meta_file" "runStdoutContains")

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
    echo "  $fixture_name/$project_name: BUILD"
    if (cd "$project_dir" && node "$cli_bin" build) >"$project_dir/.tsuba-e2e-build.log" 2>&1; then
      :
    else
      fixture_failed=true
      failed=$((failed + 1))
      echo "  $fixture_name/$project_name: FAIL"
      sed -n '1,200p' "$project_dir/.tsuba-e2e-build.log"
      break
    fi

    if [ "$fixture_run" = "true" ]; then
      echo "  $fixture_name/$project_name: RUN"
      if (cd "$project_dir" && node "$cli_bin" run) >"$project_dir/.tsuba-e2e-run.log" 2>&1; then
        :
      else
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (run)"
        sed -n '1,200p' "$project_dir/.tsuba-e2e-run.log"
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
            break 2
          fi
        done
      fi
    fi

    if [ "$fixture_test" = "true" ]; then
      echo "  $fixture_name/$project_name: TEST"
      if (cd "$project_dir" && node "$cli_bin" test) >"$project_dir/.tsuba-e2e-test.log" 2>&1; then
        :
      else
        fixture_failed=true
        failed=$((failed + 1))
        echo "  $fixture_name/$project_name: FAIL (test)"
        sed -n '1,200p' "$project_dir/.tsuba-e2e-test.log"
        break
      fi
    fi
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

echo ""
echo "E2E summary: $passed passed, $skipped skipped, $failed failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
