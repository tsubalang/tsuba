# Tsuba GPU spec (v0)

Tsuba is **GPU-first**.

The compiler must support writing **real, high-performance GPU kernels** (FlashAttention-class) as a first-class part of the language, with **airplane‑grade** guarantees:

- No silent miscompiles.
- No hidden device/host transfers, clones, boxing, or conversions.
- No “fallback to something else” when GPU features aren’t available.
- Any ambiguity or unsupported construct is a deterministic Tsuba error.

This document defines the v0 GPU model.

---

## 1. Two dialects: host + kernel

Tsuba has two related, but distinct, subsets:

1) **Host dialect** (default): lowered to Rust + Cargo crates.
2) **Kernel dialect**: a restricted TS subset that lowers to a GPU backend (CUDA/PTX first).

Kernel code must still be **valid TypeScript** and typecheck in `tsc`, but Tsuba enforces additional kernel restrictions.

Key rule: **Kernel code is not “just Rust”.** It is lowered to a GPU backend (PTX/WGSL/etc) under strict rules.

---

## 2. Packages

GPU surfaces live in dedicated packages (Tsonic-style split):

- `@tsuba/gpu/types.js` — marker **types** (pointers, address spaces, vector types, scalar dtypes like `f16`).
- `@tsuba/gpu/lang.js` — marker **functions/intrinsics** (kernel() definition, launch config, thread indices, barriers, atomics).
- `@tsuba/tensor` (optional in v0, expected soon) — higher-level tensor/view types built on `@tsuba/gpu/*`.

No decorators (e.g. `@kernel`) are required; the surface must remain TS-valid without extra syntax.

---

## 3. Kernel authoring surface (TS)

### 3.1 `kernel(spec, fn)` (no decorators)

Kernels are defined with an intrinsic:

```ts
import type { u32, f32 } from "@tsuba/core/types.js";
import type { global_ptr } from "@tsuba/gpu/types.js";
import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";

export const add = kernel(
  { name: "add", block: [256, 1, 1] as const } as const,
  (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {
    const i = blockIdxX() * blockDimX() + threadIdxX();
    if (i < n) out[i] = a[i] + b[i];
  }
);
```

Airplane-grade rules:

- `spec` must be a **compile-time constant object** (`as const` + literal values).
- `fn` must be an inline function expression (arrow or function), not an arbitrary variable.
- Kernel functions must not capture non-constant values from outer scope.
- If a kernel cannot be lowered, Tsuba errors.

### 3.2 Launching kernels from host code

```ts
import type { u32 } from "@tsuba/core/types.js";
import { deviceMalloc, memcpyHtoD, memcpyDtoH } from "@tsuba/gpu/lang.js";
import { add } from "./kernels/add.js";

export async function run(): Promise<void> {
  const n = 1024 as u32;

  const a = deviceMalloc<f32>(n);
  const b = deviceMalloc<f32>(n);
  const out = deviceMalloc<f32>(n);

  memcpyHtoD(a, hostA);
  memcpyHtoD(b, hostB);

  add.launch({ grid: [4, 1, 1], block: [256, 1, 1] } as const, a, b, out, n);

  memcpyDtoH(hostOut, out);
}
```

Rules:

- Launch config must be explicit. No implicit “auto tuning” in v0.
- Memory transfers are explicit. No implicit `.toDevice()` or hidden staging.
- If a backend is not configured (e.g. CUDA toolkit missing), kernel compilation/launch errors deterministically.

---

## 4. Types and memory model

### 4.1 Scalar dtypes

Kernel code supports explicit scalar types, including GPU-relevant ones:

- Integers: `i8/i16/i32/i64/isize`, `u8/u16/u32/u64/usize`
- Floats: `f16`, `bf16`, `f32`, `f64`
- `bool`

These are marker types (TS-level aliases) that lower to backend-specific representations.

### 4.2 Address spaces

Kernel memory is explicit and typed by address space:

- `global_ptr<T>` — device global memory
- `shared_ptr<T>` — shared memory
- `local_ptr<T>` — per-thread local
- `const_ptr<T>` — constant memory (backend permitting)

Indexing `p[i]` lowers to the appropriate load/store instruction for that address space.

### 4.3 Slices/views

For ergonomic APIs without hiding layout, v0 provides explicit view types:

- `global_slice<T>` = `{ ptr: global_ptr<T>; len: u32 }` (nominal)
- `tensor_view<T, Rank>` = `{ ptr; shape; strides }` (nominal; see below)

Tsuba must not treat JS arrays as GPU arrays.

---

## 5. Kernel dialect restrictions (v0)

Kernel code must be statically checkable with strict restrictions:

- No heap allocation, GC, or dynamic objects.
- No strings (unless proven compile-time and erased).
- No `await` inside kernel bodies.
- No exceptions/panics as control flow (panic may exist as a debug trap).
- No recursion; bounded loops only (or compiler-proven termination).
- Pointer arithmetic only in `unsafe(...)` blocks.

When in doubt, Tsuba errors.

---

## 6. Threading model intrinsics

v0 exposes CUDA-like thread/block indices (backend-agnostic API shape):

- `threadIdxX/Y/Z(): u32`
- `blockIdxX/Y/Z(): u32`
- `blockDimX/Y/Z(): u32`
- `gridDimX/Y/Z(): u32`

These are intrinsics in `@tsuba/gpu/lang.js`.

---

## 7. Shared memory + barriers

Shared memory must be explicit and fixed-size:

```ts
import type { f16 } from "@tsuba/gpu/types.js";
import { sharedArray, syncthreads } from "@tsuba/gpu/lang.js";

// inside a kernel body:
const smem = sharedArray<f16, 1024>(); // fixed element count, compile-time constant
syncthreads();
```

Rules:

- Shared allocations must have compile-time constant sizes.
- Barrier correctness is the programmer’s responsibility; Tsuba does not attempt to “fix” data races.

---

## 8. Atomics and synchronization

Tsuba provides a minimal atomic set via intrinsics:

- `atomicAdd(ptr, value)`
- `atomicMax(ptr, value)`
- `atomicCAS(ptr, expected, desired)`

Backend determines availability; missing features are a compile error unless explicitly gated.

---

## 9. Vectorization and tensor cores (v0 direction)

v0 must expose enough to write modern kernels:

- vectorized loads/stores (`ldg`, `stg`-like)
- warp shuffle operations
- tensor core ops (WMMA / MMA) gated by capability

Example shape (not final API):

```ts
import { wmma } from "@tsuba/gpu/lang.js";
wmma.mma_sync(acc, a_frag, b_frag, acc);
```

If the capability isn’t available (e.g. SM < required), compilation fails unless the kernel is explicitly specialized for another path.

---

## 10. Tensor model (explicit dtype/layout/device)

Tsuba’s tensor story must remain explicit and non-magical.

v0 requires at least:

- explicit dtype
- explicit device (host vs device)
- explicit layout (shape + strides)

Proposed nominal view type:

```ts
export type tensor_view<T, Rank extends number> = {
  readonly ptr: global_ptr<T>;
  readonly shape: readonly u32[];   // length == Rank
  readonly strides: readonly u32[]; // length == Rank
};
```

Higher-level “Tensor” owning types may exist, but must not hide transfers or layout.

---

## 11. Specialization (compile-time constants)

Kernels frequently require compile-time specialization (tile sizes, head dim, vector width).

v0 rule:

- Specialization values must come from `spec` (a compile-time constant object).
- Using non-constant specialization values is an error.

Example:

```ts
const reduceSpec = {
  name: "reduce",
  block: [256, 1, 1] as const,
  specialize: { VEC: 4 as const }
} as const;

export const k = kernel(reduceSpec, (xs: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {
  const vec = reduceSpec.specialize.VEC; // compile-time constant
  // ...
});
```

---

## 12. Backend: CUDA/PTX first

v0 targets CUDA/PTX first because it is the only realistic path to SOTA GPU kernels today.

Requirements:

- deterministic compilation (toolchain version pinned in config)
- explicit compute capability (SM version) selection
- no silent fallback (missing toolkit/driver => error)

Other backends (WGSL/WebGPU, Metal) can be added later, but must implement the same semantics.

---

## 13. Build outputs (GPU)

For a project that contains kernels:

- Host Rust crate (normal output)
- Device artifacts:
  - PTX modules per kernel bundle (or per file)
  - metadata used by host launcher

The host crate embeds or loads device code deterministically (config-controlled).

---

## 14. Testing (GPU correctness)

Tsuba must ship a testing strategy that catches miscompiles:

- “compile-only” tests for kernel lowering
- CPU reference implementations to validate kernel outputs
- deterministic seed + tolerance policies for floating-point checks

If a kernel feature cannot be tested reliably, it should not ship in v0.
