#!/usr/bin/env bash
# Typecheck Tsuba e2e fixtures with vanilla tsc.
#
# This keeps a deterministic guardrail between the compiler and TypeScript:
# every tested fixture that is intended to be supported should typecheck in
# tsc before running compilation/e2e.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES_DIR="$ROOT_DIR/test/fixtures"

FILTER_PATTERNS=()

print_help() {
  cat <<'EOF_HELP'
Usage: ./test/scripts/typecheck-fixtures.sh [--filter <pattern>]

Options:
  --filter <pattern>   Only run fixtures whose directory name contains <pattern>.
                       Can be repeated, or comma-separated (e.g. --filter host,gpu).
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

TSC="$ROOT_DIR/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC="$(which tsc || true)"
fi
if [ -z "$TSC" ] || [ ! -x "$TSC" ]; then
  echo "FAIL: tsc not found. Run npm install."
  exit 1
fi

if [ ! -d "$FIXTURES_DIR" ]; then
  echo "Typecheck fixtures: no fixture directory found at $FIXTURES_DIR"
  echo "Typecheck summary: 0 passed, 0 skipped"
  exit 0
fi

passed=0
skipped=0
failed=0
has_run=false

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

echo "=== TypeScript fixture typecheck ==="
if [ ${#FILTER_PATTERNS[@]} -gt 0 ]; then
  echo "Filter: ${FILTER_PATTERNS[*]}"
fi

for fixture_dir in "$FIXTURES_DIR"/*/; do
  [ -d "$fixture_dir" ] || continue
  fixture_name="$(basename "$fixture_dir")"
  if ! matches_filter "$fixture_name"; then
    continue
  fi
  has_run=true

  # Expected workspace-style fixture shape:
  #   <fixture>/tsuba.workspace.json
  #   <fixture>/packages/<project>/tsuba.json + src/index.ts
  if [ ! -f "$fixture_dir/tsuba.workspace.json" ]; then
    echo "  $fixture_name: SKIP (missing tsuba.workspace.json)"
    skipped=$((skipped + 1))
    continue
  fi

  # Optional support for fixtures using a one-project-at-root style.
  entry=""
  if [ -f "$fixture_dir/packages/$fixture_name/src/index.ts" ]; then
    entry="$fixture_dir/packages/$fixture_name/src/index.ts"
  elif [ -f "$fixture_dir/src/index.ts" ]; then
    entry="$fixture_dir/src/index.ts"
  else
    echo "  $fixture_name: SKIP (no src/index.ts)"
    skipped=$((skipped + 1))
    continue
  fi

  meta_file="$fixture_dir/e2e.meta.json"
  if [ -f "$meta_file" ] && grep -q '"expectFailure"[[:space:]]*:[[:space:]]*true' "$meta_file"; then
    echo "  $fixture_name: SKIP (expectFailure)"
    skipped=$((skipped + 1))
    continue
  fi

  tsconfig_file="$tmp_dir/$fixture_name.tsconfig.json"
  out_file="$tmp_dir/$fixture_name.log"

  cat >"$tsconfig_file" <<EOF
{
  "compilerOptions": {
    "noEmit": true,
    "strict": false,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "ES2022",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "allowJs": false,
    "checkJs": false,
    "noImplicitAny": false,
    "allowImportingTsExtensions": true,
    "baseUrl": "$ROOT_DIR",
    "paths": {
      "@tsuba/core": ["../packages/core/dist/index.d.ts"],
      "@tsuba/core/*": ["../packages/core/dist/*"],
      "@tsuba/gpu": ["../packages/gpu/dist/index.d.ts"],
      "@tsuba/gpu/*": ["../packages/gpu/dist/*"],
      "@tsuba/std": ["../packages/std/dist/index.d.ts"],
      "@tsuba/std/*": ["../packages/std/dist/*"],
      "@tsuba/cli": ["../packages/cli/dist/index.d.ts"],
      "@tsuba/cli/*": ["../packages/cli/dist/*"],
      "@tsuba/compiler": ["../packages/compiler/dist/index.d.ts"],
      "@tsuba/compiler/*": ["../packages/compiler/dist/*"]
    }
  },
  "files": [
    "$entry"
  ]
}
EOF

  if "$TSC" -p "$tsconfig_file" >"$out_file" 2>&1; then
    echo "  $fixture_name: PASS"
    passed=$((passed + 1))
  else
    echo "  $fixture_name: FAIL"
    failed=$((failed + 1))
    sed -n '1,200p' "$out_file"
  fi
done

if [ "$has_run" = false ]; then
  echo "Typecheck summary: 0 passed, 0 skipped, 0 failed"
  exit 0
fi

echo ""
echo "Typecheck summary: $passed passed, $skipped skipped, $failed failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
