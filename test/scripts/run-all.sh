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

echo
echo "=== Summary ==="
echo "Unit + golden tests: $UNIT_STATUS"
echo "Typecheck fixtures: $TSC_STATUS"
echo "E2E fixtures: $E2E_STATUS"

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
if [ "$TREE_STATUS" = "failed" ]; then
  exit 1
fi
