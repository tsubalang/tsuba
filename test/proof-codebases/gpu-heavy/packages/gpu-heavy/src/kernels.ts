import type { f32, u32 } from "@tsuba/core/types.js";
import type { global_ptr } from "@tsuba/gpu/types.js";
import {
  addr,
  atomicAdd,
  blockDimX,
  blockIdxX,
  kernel,
  sharedArray,
  syncthreads,
  threadIdxX,
} from "@tsuba/gpu/lang.js";

export const saxpyKernel = kernel(
  { name: "proof_saxpy" } as const,
  (a: f32, x: global_ptr<f32>, y: global_ptr<f32>, n: u32) => {
    const idx = ((blockIdxX() * blockDimX()) as u32 + threadIdxX()) as u32;
    if (idx < n) {
      y[idx] = ((a * x[idx]) as f32 + y[idx]) as f32;
    }
  }
);

export const histogramKernel = kernel(
  { name: "proof_histogram" } as const,
  (bins: global_ptr<u32>, values: global_ptr<u32>, n: u32) => {
    const idx = ((blockIdxX() * blockDimX()) as u32 + threadIdxX()) as u32;
    if (idx < n) {
      const bucket = values[idx];
      atomicAdd(addr(bins, bucket), 1 as u32);
    }
  }
);

export const blockReduceKernel = kernel(
  { name: "proof_block_reduce" } as const,
  (values: global_ptr<u32>, out: global_ptr<u32>, n: u32) => {
    const tid = threadIdxX();
    const idx = ((blockIdxX() * blockDimX()) as u32 + tid) as u32;
    const smem = sharedArray<u32, 128>();
    if (idx < n) {
      smem[tid] = values[idx];
    } else {
      smem[tid] = 0 as u32;
    }
    syncthreads();
    if (tid === (0 as u32)) {
      atomicAdd(addr(out, 0 as u32), smem[0 as u32]);
    }
  }
);
