# Mixture-of-Experts (MoE) dispatch (v0 notes)

This document captures the v0 “building blocks” we want Tsuba to support for MoE-style dispatch on GPU.

The goal is not to ship a full MoE framework in v0, but to ensure Tsuba can express the core kernels
in a **Rust/CUDA-faithful** and **airplane‑grade** way.

## Problem shape

Given:

- `expertIds[t]` (for each token `t`, the selected expert id, typically `topK` but v0 examples use `top1`)
- token features `x[t, ...]`

We want to produce:

- per-expert contiguous token batches (permute)
- later restore outputs back to original token order (unpermute)

That typically requires:

- histograms / counts per expert
- prefix sums to compute output offsets
- scatter/gather kernels (often using atomics for coordination)

## Kernel building blocks (v0)

### 1) Count tokens per expert (histogram)

```ts
import { kernel, threadIdxX, blockIdxX, blockDimX, atomicAdd, addr } from "@tsuba/gpu/lang.js";
import type { global_ptr } from "@tsuba/gpu/types.js";
import type { u32 } from "@tsuba/core/types.js";

export const countExperts = kernel(
  { name: "countExperts" } as const,
  (expertIds: global_ptr<u32>, counts: global_ptr<u32>, n: u32): void => {
    const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;
    if (i < n) {
      const e = expertIds[i];
      atomicAdd(addr(counts, e), 1 as u32);
    }
  }
);
```

Notes:

- `addr(ptr, index)` is the v0 “address-of element” helper so atomics can operate on `&counts[e]`
  without introducing a non-TS `&` operator.

### 2) Permute tokens by expert (scatter)

This is the simplest “top1” permute shape (not stable ordering).

```ts
import { kernel, threadIdxX, blockIdxX, blockDimX, atomicAdd, addr } from "@tsuba/gpu/lang.js";
import type { global_ptr } from "@tsuba/gpu/types.js";
import type { u32 } from "@tsuba/core/types.js";

export const permuteByExpert = kernel(
  { name: "permuteByExpert" } as const,
  (
    src: global_ptr<u32>,
    dst: global_ptr<u32>,
    expertIds: global_ptr<u32>,
    offsets: global_ptr<u32>,
    n: u32
  ): void => {
    const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;
    if (i < n) {
      const e = expertIds[i];
      const pos = atomicAdd(addr(offsets, e), 1 as u32);
      dst[pos] = src[i];
    }
  }
);
```

In practice:

- `offsets` is typically initialized to `prefixSum(counts)` (exclusive scan), then atomically advanced.
- Unpermute is the inverse gather using a “token → position” mapping.

## Future work (beyond v0)

- Efficient prefix-sum / scan kernels (warp primitives + shared memory).
- `topK` routing (multiple experts per token) with stable ordering guarantees.
- A host-level API (`buildDispatchPlan`, `routeTopK`) layered on these kernels.

