import type { f32, u32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";
import { deviceFree, deviceMalloc } from "@tsuba/gpu/lang.js";

import { blockReduceKernel, histogramKernel, saxpyKernel } from "./kernels.js";

export function main(): void {
  const n = 128 as u32;
  const bins = deviceMalloc<u32>(32 as u32);
  const values = deviceMalloc<u32>(n);
  const out = deviceMalloc<u32>(1 as u32);
  const x = deviceMalloc<f32>(n);
  const y = deviceMalloc<f32>(n);

  saxpyKernel.launch(
    { grid: [1 as u32, 1 as u32, 1 as u32], block: [128 as u32, 1 as u32, 1 as u32] },
    2 as f32,
    x,
    y,
    n
  );
  histogramKernel.launch(
    { grid: [1 as u32, 1 as u32, 1 as u32], block: [128 as u32, 1 as u32, 1 as u32] },
    bins,
    values,
    n
  );
  blockReduceKernel.launch(
    { grid: [1 as u32, 1 as u32, 1 as u32], block: [128 as u32, 1 as u32, 1 as u32] },
    values,
    out,
    n
  );

  deviceFree(x);
  deviceFree(y);
  deviceFree(values);
  deviceFree(bins);
  deviceFree(out);

  println("proof-gpu-heavy kernels-ready {}", n);
}
