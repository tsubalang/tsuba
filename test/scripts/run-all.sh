#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

QUICK_MODE=false
SKIP_UNIT=false
FILTER_PATTERNS=()
START_GIT_STATUS=""
END_GIT_STATUS=""
TREE_STATUS="skipped"

print_help() {
  cat <<'EOF_HELP'
Usage: ./test/scripts/run-all.sh [--quick] [--no-unit] [--filter <pattern>]

Options:
  --quick                Skip E2E tests (unit + fixture typecheck only)
  --no-unit              Skip unit + golden tests (fixtures only)
  --filter <pattern>     Run only matching fixture names (substring match).
                         Can be repeated, or comma-separated (e.g. --filter host,gpu).
  -h, --help             Show this help
EOF_HELP
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --quick)
      QUICK_MODE=true
      shift
      ;;
    --no-unit)
      SKIP_UNIT=true
      shift
      ;;
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

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  START_GIT_STATUS="$(git status --porcelain --untracked-files=all || true)"
fi

UNIT_STATUS="skipped"
TSC_STATUS="skipped"
E2E_STATUS="skipped"
SMOKE_STATUS="skipped"
GPU_REF_STATUS="skipped"
TRACE_STATUS="skipped"
PERF_STATUS="skipped"

if [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "NOTE: FILTERED mode (${FILTER_PATTERNS[*]}). Not for final verification."
fi

# ------------------------------------------------------------
# 1) Unit + golden tests
# ------------------------------------------------------------
if [ "$SKIP_UNIT" = true ]; then
  echo "Skipping unit/golden tests (--no-unit)."
else
  echo "==> Unit + golden tests (npm test)"
  if npm test; then
    UNIT_STATUS="passed"
  else
    UNIT_STATUS="failed"
  fi
fi

# ------------------------------------------------------------
# 2) Fixture typecheck guardrail (fast sanity gate)
# ------------------------------------------------------------
typecheck_args=(bash "$SCRIPT_DIR/typecheck-fixtures.sh")
for pat in "${FILTER_PATTERNS[@]}"; do
  typecheck_args+=(--filter "$pat")
done

echo "==> TypeScript fixture typecheck"
if "${typecheck_args[@]}"; then
  TSC_STATUS="passed"
else
  TSC_STATUS="failed"
fi

# ------------------------------------------------------------
# 3) E2E fixtures
# ------------------------------------------------------------
if [ "$QUICK_MODE" = true ]; then
  echo "Skipping E2E (--quick)."
else
  e2e_args=(bash "$SCRIPT_DIR/run-e2e.sh")
  for pat in "${FILTER_PATTERNS[@]}"; do
    e2e_args+=(--filter "$pat")
  done

  echo "==> E2E fixtures"
  if "${e2e_args[@]}"; then
    E2E_STATUS="passed"
  else
    E2E_STATUS="failed"
  fi
fi

# ------------------------------------------------------------
# 4) Clean temp-dir CLI smoke workflow
# ------------------------------------------------------------
if [ "$QUICK_MODE" = true ] || [ "$SKIP_UNIT" = true ] || [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Skipping E2E performance budget check (requires full, unfiltered run)."
else
  if [ "$E2E_STATUS" = "passed" ]; then
    echo "==> E2E performance budget check"
    if node "$ROOT_DIR/scripts/check-perf-budgets.mjs"; then
      PERF_STATUS="passed"
    else
      PERF_STATUS="failed"
    fi
  else
    echo "Skipping E2E performance budget check (E2E did not pass)."
  fi
fi

# ------------------------------------------------------------
# 5) Clean temp-dir CLI smoke workflow
# ------------------------------------------------------------
if [ "$QUICK_MODE" = true ] || [ "$SKIP_UNIT" = true ] || [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Skipping CLI smoke workflow (requires full, unfiltered run)."
else
  echo "==> CLI smoke workflow (init/build/run/test/add/bindgen)"
  if bash "$SCRIPT_DIR/smoke-cli.sh"; then
    SMOKE_STATUS="passed"
  else
    SMOKE_STATUS="failed"
  fi
fi

# ------------------------------------------------------------
# 6) Optional GPU correctness check (only when runtime is available)
# ------------------------------------------------------------
if [ "$QUICK_MODE" = true ] || [ "$SKIP_UNIT" = true ] || [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Skipping GPU CPU-reference workflow (requires full, unfiltered run)."
else
  echo "==> GPU CPU-reference workflow (auto-skips when CUDA runtime is unavailable)"
  if bash "$SCRIPT_DIR/gpu-cpu-reference.sh"; then
    GPU_REF_STATUS="passed"
  else
    GPU_REF_STATUS="failed"
  fi
fi

# ------------------------------------------------------------
# 7) Release traceability report validation
# ------------------------------------------------------------
if [ "$QUICK_MODE" = true ] || [ "$SKIP_UNIT" = true ] || [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Skipping release traceability check (requires full, unfiltered run)."
else
  echo "==> Release traceability report validation"
  if node "$ROOT_DIR/scripts/release-traceability.mjs" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf-8");
const report = JSON.parse(raw);
if (report?.schema !== 1) process.exit(1);
if (report?.kind !== "release-traceability") process.exit(1);
if (typeof report?.git?.commit !== "string" || report.git.commit.length < 7) process.exit(1);
if (!Array.isArray(report?.npmPackages) || report.npmPackages.length === 0) process.exit(1);
if (!Array.isArray(report?.crates) || report.crates.length === 0) process.exit(1);
'; then
    TRACE_STATUS="passed"
  else
    TRACE_STATUS="failed"
  fi
fi

echo
echo "=== Summary ==="
echo "Unit + golden tests: $UNIT_STATUS"
echo "Typecheck fixtures: $TSC_STATUS"
echo "E2E fixtures: $E2E_STATUS"
echo "E2E perf budgets: $PERF_STATUS"
echo "CLI smoke workflow: $SMOKE_STATUS"
echo "GPU CPU-reference workflow: $GPU_REF_STATUS"
echo "Release traceability: $TRACE_STATUS"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  END_GIT_STATUS="$(git status --porcelain --untracked-files=all || true)"
  if [ "$START_GIT_STATUS" = "$END_GIT_STATUS" ]; then
    TREE_STATUS="passed"
  else
    TREE_STATUS="failed"
  fi
  echo "Repo dirtiness gate: $TREE_STATUS"
  if [ "$TREE_STATUS" = "failed" ]; then
    echo
    echo "FAIL: tests changed repository state."
    echo "--- git status before ---"
    if [ -n "$START_GIT_STATUS" ]; then
      printf '%s\n' "$START_GIT_STATUS"
    else
      echo "(clean)"
    fi
    echo "--- git status after ---"
    if [ -n "$END_GIT_STATUS" ]; then
      printf '%s\n' "$END_GIT_STATUS"
    else
      echo "(clean)"
    fi
  fi
fi

if [ "$UNIT_STATUS" != "passed" ] && [ "$UNIT_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$TSC_STATUS" != "passed" ] && [ "$TSC_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$E2E_STATUS" != "passed" ] && [ "$E2E_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$PERF_STATUS" != "passed" ] && [ "$PERF_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$SMOKE_STATUS" != "passed" ] && [ "$SMOKE_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$GPU_REF_STATUS" != "passed" ] && [ "$GPU_REF_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$TRACE_STATUS" != "passed" ] && [ "$TRACE_STATUS" != "skipped" ]; then
  exit 1
fi
if [ "$TREE_STATUS" = "failed" ]; then
  exit 1
fi
