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
declare const __tsuba_global_ptr: unique symbol;
declare const __tsuba_shared_ptr: unique symbol;
declare const __tsuba_local_ptr: unique symbol;
declare const __tsuba_const_ptr: unique symbol;

type PtrBrand<K extends symbol> = {
  readonly [k in K]: K;
};

export type global_ptr<T> = PtrBrand<typeof __tsuba_global_ptr> & {
  [index: number]: T;
};
export type shared_ptr<T> = PtrBrand<typeof __tsuba_shared_ptr> & {
  [index: number]: T;
};
export type local_ptr<T> = PtrBrand<typeof __tsuba_local_ptr> & {
  [index: number]: T;
};
export type const_ptr<T> = PtrBrand<typeof __tsuba_const_ptr> & {
  readonly [index: number]: T;
};
