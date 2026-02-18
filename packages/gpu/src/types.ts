// @tsuba/gpu/types.js
// Marker types only. Tsuba erases these at compile time.

export type {
  bool,
  f16,
  bf16,
  f32,
  f64,
  i32,
  u32,
  u64,
  usize,
} from "@tsuba/core/types.js";

// Address-space typed pointers
export type global_ptr<T> = unknown & (T extends unknown ? unknown : never);
export type shared_ptr<T> = unknown & (T extends unknown ? unknown : never);
export type local_ptr<T> = unknown & (T extends unknown ? unknown : never);
export type const_ptr<T> = unknown & (T extends unknown ? unknown : never);
