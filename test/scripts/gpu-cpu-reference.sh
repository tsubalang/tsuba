#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/dist/bin.js"

if [ ! -f "$CLI_BIN" ]; then
  echo "SKIP: CLI binary is missing ($CLI_BIN)."
  echo "Run npm run -w @tsuba/cli build first."
  exit 0
fi

detect_nvcc() {
  if [ -n "${TSUBA_GPU_NVCC_PATH:-}" ] && [ -x "${TSUBA_GPU_NVCC_PATH}" ]; then
    printf "%s" "${TSUBA_GPU_NVCC_PATH}"
    return 0
  fi
  if command -v nvcc >/dev/null 2>&1; then
    command -v nvcc
    return 0
  fi
  return 1
}

if ! NVCC_BIN="$(detect_nvcc)"; then
  echo "SKIP: nvcc was not found (set TSUBA_GPU_NVCC_PATH or install CUDA toolkit)."
  exit 0
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "SKIP: nvidia-smi was not found; GPU runtime is unavailable."
  exit 0
fi

if ! nvidia-smi -L >/dev/null 2>&1; then
  echo "SKIP: nvidia-smi did not detect a usable NVIDIA GPU runtime."
  exit 0
fi

TOOLKIT_PATH="$(cd "$(dirname "$NVCC_BIN")/.." && pwd)"
CUDA_SM="${TSUBA_GPU_SM:-80}"

TMP_BASE="$ROOT_DIR/.tsuba"
mkdir -p "$TMP_BASE"
TMP_DIR="$(mktemp -d "$TMP_BASE/gpu-cpu-reference-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

WORKSPACE_FILE="$TMP_DIR/tsuba.workspace.json"
PROJECT_DIR="$TMP_DIR/packages/gpu-cpu-reference"
mkdir -p "$PROJECT_DIR/src"

cat >"$WORKSPACE_FILE" <<EOF_WORKSPACE
{
  "schema": 1,
  "rustEdition": "2021",
  "packagesDir": "packages",
  "generatedDirName": "generated",
  "cargoTargetDir": ".tsuba/target",
  "gpu": {
    "backend": "cuda",
    "cuda": {
      "toolkitPath": "$TOOLKIT_PATH",
      "sm": $CUDA_SM
    }
  },
  "runtime": {
    "kind": "none"
  }
}
EOF_WORKSPACE

cat >"$PROJECT_DIR/tsuba.json" <<'EOF_PROJECT'
{
  "schema": 1,
  "name": "gpu-cpu-reference",
  "kind": "bin",
  "entry": "src/index.ts",
  "gpu": {
    "enabled": true
  },
  "crate": {
    "name": "gpu_cpu_reference"
  }
}
EOF_PROJECT

cat >"$PROJECT_DIR/src/index.ts" <<'EOF_SOURCE'
import { kernel, threadIdxX, blockIdxX, blockDimX, deviceMalloc, deviceFree, memcpyHtoD, memcpyDtoH } from "@tsuba/gpu/lang.js";
import { Vec, println, panic } from "@tsuba/std/prelude.js";
import type { f32, u32, mut } from "@tsuba/core/types.js";
import type { global_ptr } from "@tsuba/gpu/types.js";

const addOne = kernel(
  { name: "add_one" } as const,
  (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {
    const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;
    if (i < n) {
      out[i] = a[i] + b[i];
    }
  }
);

function cpuAdd(lhs: f32, rhs: f32): f32 {
  return (lhs + rhs) as f32;
}

export function main(): void {
  const n = 1 as u32;
  let aHost: mut<Vec<f32>> = Vec.new<f32>();
  let bHost: mut<Vec<f32>> = Vec.new<f32>();
  let outHost: mut<Vec<f32>> = Vec.new<f32>();
  aHost.push(2 as f32);
  bHost.push(3 as f32);
  outHost.push(0 as f32);

  const a = deviceMalloc<f32>(n);
  const b = deviceMalloc<f32>(n);
  const out = deviceMalloc<f32>(n);
  memcpyHtoD(a, aHost);
  memcpyHtoD(b, bHost);
  addOne.launch(
    {
      grid: [1 as u32, 1 as u32, 1 as u32],
      block: [1 as u32, 1 as u32, 1 as u32]
    } as const,
    a,
    b,
    out,
    n
  );
  memcpyDtoH(outHost, out);
  deviceFree(a);
  deviceFree(b);
  deviceFree(out);

  const got = outHost.get(0 as u32);
  if (!got.some) {
    panic("gpu-cpu-reference: missing output element");
  }
  const expected = cpuAdd(2 as f32, 3 as f32);
  if (got.value !== expected) {
    panic("gpu-cpu-reference: mismatch");
  }
  println("gpu-cpu-reference ok");
}
EOF_SOURCE

RUN_LOG="$PROJECT_DIR/.gpu-cpu-reference.run.log"
if ! (cd "$PROJECT_DIR" && node "$CLI_BIN" run) >"$RUN_LOG" 2>&1; then
  echo "FAIL: GPU CPU reference project failed to run."
  sed -n '1,200p' "$RUN_LOG"
  exit 1
fi

if ! grep -Fq "gpu-cpu-reference ok" "$RUN_LOG"; then
  echo "FAIL: GPU CPU reference output marker not found."
  sed -n '1,200p' "$RUN_LOG"
  exit 1
fi

echo "PASS: GPU CPU reference check passed."
