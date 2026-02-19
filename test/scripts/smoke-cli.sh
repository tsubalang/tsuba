#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/dist/bin.js"

if [ ! -f "$CLI_BIN" ]; then
  echo "FAIL: missing CLI binary at $CLI_BIN (run npm run -w @tsuba/cli build first)."
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

run_bin() {
  local cwd="$1"
  shift
  (cd "$cwd" && node "$CLI_BIN" "$@")
}

workspace_root="$TMP_DIR/smoke"
mkdir -p "$workspace_root"

echo "==> smoke-cli: init/build/run/test"
run_bin "$workspace_root" init

project_name="$(basename "$workspace_root")"
project_root="$workspace_root/packages/$project_name"

run_bin "$project_root" build
run_bin "$project_root" run
run_bin "$project_root" test

echo "==> smoke-cli: add path crate"
crate_root="$workspace_root/local-crates/simple-crate"
mkdir -p "$crate_root/src"
cat >"$crate_root/Cargo.toml" <<'EOF_CARGO'
[package]
name = "simple-crate"
version = "0.1.0"
edition = "2021"

[lib]
name = "simple_crate"
path = "src/lib.rs"
EOF_CARGO
cat >"$crate_root/src/lib.rs" <<'EOF_RUST'
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
EOF_RUST

run_bin "$project_root" add path simple_crate ../../local-crates/simple-crate
run_bin "$project_root" build
run_bin "$project_root" test

echo "==> smoke-cli: standalone bindgen"
run_bin "$workspace_root" bindgen \
  --manifest-path ./local-crates/simple-crate/Cargo.toml \
  --out ./bindings-out \
  --package @tsuba/simple-crate

if [ ! -f "$workspace_root/bindings-out/package.json" ]; then
  echo "FAIL: smoke-cli expected bindings-out/package.json"
  exit 1
fi
if [ ! -f "$workspace_root/bindings-out/tsuba.bindings.json" ]; then
  echo "FAIL: smoke-cli expected bindings-out/tsuba.bindings.json"
  exit 1
fi
if [ ! -f "$workspace_root/bindings-out/index.d.ts" ]; then
  echo "FAIL: smoke-cli expected bindings-out/index.d.ts"
  exit 1
fi

echo "==> smoke-cli: standalone bindgen (bundled crate)"
run_bin "$workspace_root" bindgen \
  --manifest-path ./local-crates/simple-crate/Cargo.toml \
  --out ./bindings-out-bundled \
  --package @tsuba/simple-crate-bundled \
  --bundle-crate

if [ ! -f "$workspace_root/bindings-out-bundled/crate/Cargo.toml" ]; then
  echo "FAIL: smoke-cli expected bindings-out-bundled/crate/Cargo.toml"
  exit 1
fi
if [ ! -f "$workspace_root/bindings-out-bundled/tsuba.bindings.json" ]; then
  echo "FAIL: smoke-cli expected bindings-out-bundled/tsuba.bindings.json"
  exit 1
fi

echo "smoke-cli: PASS"
