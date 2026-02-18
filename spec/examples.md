# Tsuba examples (draft)

These examples are meant to clarify the *intended* user experience and the “airplane‑grade” constraints.

Tsuba is **GPU-first**. That means:

- Kernels are authored in Tsuba (TS surface) and compiled to a GPU backend (CUDA/PTX first).
- Host/device boundaries are explicit (no hidden transfers).
- If something can’t be lowered deterministically, Tsuba errors.

> Note: Some imports below (e.g. `@tsuba/tch`, `@tsuba/tensor`) represent “bindgen facades” over Rust crates; they may not exist yet. The point is to define what the surface *should* look like.

---

## 1) Minimal project shape

Workspace layout (like Tsonic):

```
my-workspace/
  tsuba.workspace.json
  packages/
    hello/
      tsuba.json
      src/
        main.ts
```

The “GPU-first” default should come from workspace config (toolchain pinning, SM target, etc).

---

## 2) Example: GPU vector add (host + kernel)

### Python (Triton)

```py
import triton
import triton.language as tl

@triton.jit
def add_kernel(a_ptr, b_ptr, out_ptr, n, BLOCK: tl.constexpr):
    pid = tl.program_id(0)
    offs = pid * BLOCK + tl.arange(0, BLOCK)
    mask = offs < n
    a = tl.load(a_ptr + offs, mask=mask, other=0.0)
    b = tl.load(b_ptr + offs, mask=mask, other=0.0)
    tl.store(out_ptr + offs, a + b, mask=mask)
```

### Rust (conceptual; CUDA driver + PTX)

```rs
// Conceptual:
// - compile PTX
// - load module
// - allocate device buffers
// - launch kernel with grid/block
// - copy back
```

### Tsuba (target experience)

**Kernel**

```ts
import type { u32 } from "@tsuba/core/types.js";
import type { f32, global_ptr } from "@tsuba/gpu/types.js";
import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";

const addSpec = { name: "add", block: [256, 1, 1] as const } as const;

export const add = kernel(
  addSpec,
  (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {
    const i = blockIdxX() * blockDimX() + threadIdxX();
    if (i < n) out[i] = a[i] + b[i];
  }
);
```

**Host**

```ts
import type { u32 } from "@tsuba/core/types.js";
import type { f32, global_ptr } from "@tsuba/gpu/types.js";
import { deviceMalloc, memcpyHtoD, memcpyDtoH } from "@tsuba/gpu/lang.js";
import { add } from "./kernels/add.js";

export function runAdd(hostA: Float32Array, hostB: Float32Array): Float32Array {
  const n = hostA.length as u32;

  const a: global_ptr<f32> = deviceMalloc<f32>(n);
  const b: global_ptr<f32> = deviceMalloc<f32>(n);
  const out: global_ptr<f32> = deviceMalloc<f32>(n);

  memcpyHtoD(a, hostA);
  memcpyHtoD(b, hostB);

  add.launch({ grid: [ceilDiv(n, 256), 1, 1], block: [256, 1, 1] } as const, a, b, out, n);

  const hostOut = new Float32Array(hostA.length);
  memcpyDtoH(hostOut, out);
  return hostOut;
}
```

**Airplane-grade constraints illustrated**

- Kernel uses explicit `global_ptr<T>` and explicit indices.
- Host explicitly allocates and copies.
- Launch config is explicit and compile-time validated.
- If CUDA toolkit/SM target is missing/mismatched, build fails (no silent fallback).

---

## 3) Example: inference step (KV cache attention + sampling)

This is an example of “library glue + ability to swap in custom kernels later”.

### Python (PyTorch-ish)

```py
import torch
from torch.nn.functional import scaled_dot_product_attention

def step(x, k_cache, v_cache, Wq, Wk, Wv, Wo):
    q = x @ Wq
    k = x @ Wk
    v = x @ Wv
    k_all = torch.cat([k_cache, k], dim=1)
    v_all = torch.cat([v_cache, v], dim=1)
    y = scaled_dot_product_attention(q, k_all, v_all)
    return y @ Wo, k_all, v_all
```

### Rust (conceptual; candle/burn/tch)

```rs
// Conceptual:
// - matmul for q/k/v
// - concat to extend cache
// - sdpa op (library)
// - matmul Wo
```

### Tsuba (target experience)

```ts
import type { ref } from "@tsuba/core/types.js";
import { Tensor } from "@tsuba/tensor/index.js";

export function step(
  x: ref<Tensor>,
  kCache: ref<Tensor>,
  vCache: ref<Tensor>,
  Wq: ref<Tensor>,
  Wk: ref<Tensor>,
  Wv: ref<Tensor>,
  Wo: ref<Tensor>
): { y: Tensor; kAll: Tensor; vAll: Tensor } {
  const q = x.matmul(Wq);
  const k = x.matmul(Wk);
  const v = x.matmul(Wv);

  const kAll = Tensor.cat([kCache, k], 1);
  const vAll = Tensor.cat([vCache, v], 1);

  // Library op today; replaceable with a Tsuba-authored kernel later.
  const y0 = Tensor.sdpa(q, kAll, vAll);
  const y = y0.matmul(Wo);

  return { y, kAll, vAll };
}
```

**Airplane-grade constraints illustrated**

- Borrow markers are explicit (`ref<T>`).
- No implicit device transfers (“Tensor” is an explicit device/layout-bearing type, not a JS array).
- Custom kernels can slot in without changing host semantics.

---

## 4) Example: training step (autograd)

For training, the *practical* v0 approach is to bind to an existing training runtime (libtorch via `tch`, or a Rust framework).

### Python (PyTorch)

```py
import torch
import torch.nn as nn

model = nn.Sequential(nn.Linear(1024, 4096), nn.ReLU(), nn.Linear(4096, 1024)).cuda()
opt = torch.optim.AdamW(model.parameters(), lr=1e-4)

x = torch.randn(64, 1024, device="cuda")
y = torch.randn(64, 1024, device="cuda")

opt.zero_grad()
loss = (model(x) - y).square().mean()
loss.backward()
opt.step()
```

### Rust (`tch` / libtorch)

```rs
use tch::{nn, nn::Module, nn::OptimizerConfig, Device, Tensor};

fn main() -> anyhow::Result<()> {
    let vs = nn::VarStore::new(Device::Cuda(0));
    let root = &vs.root();
    let l1 = nn::linear(root / "l1", 1024, 4096, Default::default());
    let l2 = nn::linear(root / "l2", 4096, 1024, Default::default());
    let mut opt = nn::AdamW::default().build(&vs, 1e-4)?;

    let x = Tensor::randn([64, 1024], (tch::Kind::Float, vs.device()));
    let y = Tensor::randn([64, 1024], (tch::Kind::Float, vs.device()));

    let pred = x.apply(&l1).relu().apply(&l2);
    let loss = (&pred - &y).pow_tensor_scalar(2.0).mean(tch::Kind::Float);
    opt.backward_step(&loss);
    Ok(())
}
```

### Tsuba (target experience via bindgen)

```ts
import { Tensor, nn, AdamW, relu } from "@tsuba/tch/index.js";

export function trainStep(): void {
  const device = nn.Device.cuda(0);
  const vs = nn.VarStore.new(device);

  const l1 = nn.linear(vs.root().child("l1"), 1024, 4096);
  const l2 = nn.linear(vs.root().child("l2"), 4096, 1024);

  const x = Tensor.randn([64, 1024], device);
  const y = Tensor.randn([64, 1024], device);

  const pred = l2.forward(relu(l1.forward(x)));
  const loss = pred.sub(y).square().mean();

  const opt = AdamW.build(vs, 1e-4);
  opt.backwardStep(loss);
}
```

**Airplane-grade constraints illustrated**

- This example is “glue” rather than “re-implement autograd”.
- Custom ops/kernels can be authored in Tsuba, then bound as functions that participate in the runtime’s autograd (v0 may require explicit “custom op” adapters).

---

## 5) Example: FlashAttention-class kernel (skeleton)

This is intentionally a skeleton; real FlashAttention is long and heavily specialized.

### Python (typical usage)

```py
y = flash_attn_func(q, k, v, causal=True)
```

### Tsuba (goal: write the kernel)

```ts
import type { f16, f32, global_ptr } from "@tsuba/gpu/types.js";
import { kernel, syncthreads, sharedArray } from "@tsuba/gpu/lang.js";

const faSpec = {
  name: "flash_attn_fwd",
  block: [256, 1, 1] as const,
  specialize: { HEAD_DIM: 128 as const, TILE_M: 64 as const, TILE_N: 64 as const }
} as const;

export const flashAttnFwd = kernel(faSpec, (
  q: global_ptr<f16>,
  k: global_ptr<f16>,
  v: global_ptr<f16>,
  out: global_ptr<f16>
): void => {
  const qTile = sharedArray<f16, 64 * 128>();
  const kTile = sharedArray<f16, 64 * 128>();
  const vTile = sharedArray<f16, 64 * 128>();

  // load tiles -> sync -> MMA -> online softmax -> write out
  syncthreads();
});
```

**Airplane-grade constraints illustrated**

- Tile sizes are compile-time constants (from `faSpec`).
- Shared memory sizes are compile-time constants.
- Tensor core usage must be capability-gated; missing capability = compile error unless explicitly specialized.

---

## 6) Example: CPU + SIMD (direction)

Tsuba should allow CPU vectorization by binding Rust SIMD types and intrinsics through facades.

### Rust (`std::simd`)

```rs
use std::simd::f32x8;

fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = f32x8::splat(0.0);
    for i in (0..a.len()).step_by(8) {
        let va = f32x8::from_slice(&a[i..i+8]);
        let vb = f32x8::from_slice(&b[i..i+8]);
        acc += va * vb;
    }
    acc.reduce_sum()
}
```

### Tsuba (target experience)

```ts
import type { ref, f32 } from "@tsuba/core/types.js";
import { f32x8 } from "@tsuba/std/simd.js";

export function dot(a: ref<Float32Array>, b: ref<Float32Array>): f32 {
  let acc = f32x8.splat(0 as f32);
  for (let i = 0; i < a.length; i += 8) {
    const va = f32x8.fromSlice(a, i);
    const vb = f32x8.fromSlice(b, i);
    acc = acc.add(va.mul(vb));
  }
  return acc.reduceSum();
}
```

---

## 7) Kernel dialect v0 checklist (non-negotiable)

To be credible as a GPU-first language, v0 must include at least:

1) **Memory + address spaces**
   - `global_ptr<T>`, `shared_ptr<T>`, `local_ptr<T>` (or equivalent)
   - explicit loads/stores and indexing rules

2) **Thread/block indices**
   - CUDA-like indexing intrinsics (or backend-agnostic equivalents)

3) **Shared memory + barriers**
   - fixed-size shared allocations with compile-time constants
   - `syncthreads()` (and eventually warp-level barriers)

4) **Atomics**
   - minimal atomic ops (add/max/cas) with capability gating

5) **Specialization**
   - compile-time constants in `spec`
   - error when specialization depends on runtime values

6) **Deterministic backend**
   - CUDA/PTX toolchain pinning
   - explicit SM target selection
   - no silent fallback to CPU or to a different kernel path

7) **Testing strategy**
   - compile-only kernel tests
   - deterministic reference correctness tests (CPU baseline + tolerances)
   - no untestable features in v0

