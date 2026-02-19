#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

RUN_TESTS=true
DRY_RUN=false
RUN_PROOF=true
PROOF_REPO=""

print_help() {
  cat <<'EOF_HELP'
Usage: ./scripts/publish-crates.sh [--no-tests] [--dry-run] [--no-proof] [--proof-repo <path>]

Safety checks (always on):
  - must run on branch main
  - working tree must be clean
  - local main must match origin/main
  - crate versions must not already exist on crates.io
  - proof verification must pass (requires proof repo)

Options:
  --no-tests   Skip npm run run-all (not recommended for releases)
  --dry-run    Run checks and print publish plan without publishing
  --no-proof   Skip proof verification (not recommended for releases)
  --proof-repo Override proof repo path used by verify-proof.sh
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
    --no-proof)
      RUN_PROOF=false
      shift
      ;;
    --proof-repo)
      shift
      if [ -z "${1:-}" ]; then
        echo "FAIL: --proof-repo requires a path"
        exit 2
      fi
      PROOF_REPO="$1"
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

if [ "$RUN_PROOF" = true ]; then
  echo "==> Running proof verification (required)"
  proof_args=(bash "$ROOT_DIR/scripts/verify-proof.sh" --require)
  if [ -n "$PROOF_REPO" ]; then
    proof_args+=(--repo "$PROOF_REPO")
  fi
  "${proof_args[@]}"
else
  echo "WARN: skipping proof verification (--no-proof)."
fi

echo "==> Release traceability snapshot"
node "$ROOT_DIR/scripts/release-traceability.mjs" --pretty

echo "==> Release notes snapshot"
mkdir -p "$ROOT_DIR/.tsuba"
release_notes_path="$ROOT_DIR/.tsuba/release-notes.latest.md"
node "$ROOT_DIR/scripts/release-notes.mjs" --auto-range --to HEAD --out "$release_notes_path"
echo "Release notes: $release_notes_path"

mapfile -t crate_manifests < <(
  git ls-files '**/Cargo.toml' |
    grep -v '^test/fixtures/' |
    grep -v '^\.tsuba/' |
    sort
)

if [ "${#crate_manifests[@]}" -eq 0 ]; then
  echo "No crate manifests found."
  exit 0
fi

read_package_field() {
  local manifest="$1"
  local field="$2"
  awk -v field="$field" '
    /^\[package\]/ { in_pkg=1; next }
    /^\[/ { if (in_pkg) exit }
    in_pkg && $0 ~ "^[[:space:]]*" field "[[:space:]]*=" {
      line=$0
      sub(/^[^=]*=[[:space:]]*/, "", line)
      gsub(/^[\"\047]|[\"\047][[:space:]]*$/, "", line)
      print line
      exit
    }
  ' "$manifest"
}

crate_names=()
crate_versions=()
publish_manifests=()

for manifest in "${crate_manifests[@]}"; do
  name="$(read_package_field "$manifest" "name")"
  version="$(read_package_field "$manifest" "version")"
  publish_flag="$(read_package_field "$manifest" "publish")"

  if [ -z "$name" ] || [ -z "$version" ]; then
    echo "FAIL: could not read [package] name/version from $manifest"
    exit 1
  fi

  if [ "$publish_flag" = "false" ]; then
    continue
  fi

  if curl -fsSI "https://crates.io/api/v1/crates/${name}/${version}/download" >/dev/null; then
    echo "FAIL: ${name}@${version} already exists on crates.io. Bump version first."
    exit 1
  fi

  publish_manifests+=("$manifest")
  crate_names+=("$name")
  crate_versions+=("$version")
done

if [ "${#publish_manifests[@]}" -eq 0 ]; then
  echo "No publishable crates found."
  exit 0
fi

echo "==> Publish plan"
for idx in "${!crate_names[@]}"; do
  echo "  - ${crate_names[$idx]}@${crate_versions[$idx]} (${publish_manifests[$idx]})"
done

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete."
  exit 0
fi

if [ -z "${CARGO_REGISTRY_TOKEN:-}" ]; then
  echo "FAIL: CARGO_REGISTRY_TOKEN is not set."
  exit 1
fi

for manifest in "${publish_manifests[@]}"; do
  echo "==> Publishing crate from ${manifest}"
  cargo publish --manifest-path "$manifest"
done

echo "Crate publish complete."
