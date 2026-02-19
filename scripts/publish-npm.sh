#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

RUN_TESTS=true
DRY_RUN=false

print_help() {
  cat <<'EOF_HELP'
Usage: ./scripts/publish-npm.sh [--no-tests] [--dry-run]

Safety checks (always on):
  - must run on branch main
  - working tree must be clean
  - local main must match origin/main
  - package versions must not already exist on npm

Options:
  --no-tests   Skip npm run run-all (not recommended for releases)
  --dry-run    Run checks and print publish plan without publishing
  -h, --help   Show this help
EOF_HELP
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --no-tests)
      RUN_TESTS=false
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "main" ]; then
  echo "FAIL: publish must run from branch 'main' (current: $current_branch)"
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "FAIL: working tree is not clean."
  git status --short
  exit 1
fi

git fetch origin main --quiet
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" != "$remote_head" ]; then
  echo "FAIL: local main is not synced with origin/main."
  echo "local:  $local_head"
  echo "origin: $remote_head"
  exit 1
fi

if [ "$RUN_TESTS" = true ]; then
  echo "==> Running full verification (npm run run-all)"
  npm run run-all
else
  echo "WARN: skipping tests (--no-tests)."
fi

PACKAGE_DIRS=(
  "packages/core"
  "packages/std"
  "packages/gpu"
  "packages/compiler"
  "packages/tsubabindgen"
  "packages/cli"
)

publish_names=()
publish_versions=()
publish_dirs=()

for dir in "${PACKAGE_DIRS[@]}"; do
  package_json="$ROOT_DIR/$dir/package.json"
  if [ ! -f "$package_json" ]; then
    echo "FAIL: missing package.json: $package_json"
    exit 1
  fi

  private_flag="$(node -p "Boolean(require('$package_json').private)")"
  if [ "$private_flag" = "true" ]; then
    continue
  fi

  name="$(node -p "require('$package_json').name")"
  version="$(node -p "require('$package_json').version")"

  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "FAIL: ${name}@${version} already exists on npm. Bump version first."
    exit 1
  fi

  publish_names+=("$name")
  publish_versions+=("$version")
  publish_dirs+=("$dir")
done

if [ "${#publish_names[@]}" -eq 0 ]; then
  echo "FAIL: no publishable packages found."
  exit 1
fi

echo "==> Publish plan"
for idx in "${!publish_names[@]}"; do
  echo "  - ${publish_names[$idx]}@${publish_versions[$idx]} (${publish_dirs[$idx]})"
done

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete."
  exit 0
fi

for idx in "${!publish_names[@]}"; do
  dir="${publish_dirs[$idx]}"
  name="${publish_names[$idx]}"
  version="${publish_versions[$idx]}"
  echo "==> Publishing ${name}@${version}"
  npm publish "$dir" --access public
done

echo "Publish complete."
