// @tsuba/gpu/lang.js
// Marker functions only. Tsuba erases these at compile time.

import type { u32 } from "@tsuba/core/types.js";
import type { mutref, ref } from "@tsuba/core/types.js";
import type { Vec } from "@tsuba/std/prelude.js";
import type { global_ptr, shared_ptr } from "./types.js";

function marker(name: string): never {
  throw new Error(`@tsuba/gpu: '${name}' is a compile-time marker (not callable at runtime).`);
}

export type Dim3 = readonly [u32, u32, u32];

export type LaunchConfig = {
  readonly grid: Dim3;
  readonly block: Dim3;
};

export type Kernel<Args extends readonly unknown[]> = {
  launch(config: LaunchConfig, ...args: Args): void;
};

export function kernel<Args extends readonly unknown[]>(
  spec: unknown,
  fn: (...args: Args) => void
): Kernel<Args> {
  void spec;
  void fn;
  return marker("kernel");
}

// Thread/block intrinsics
export function threadIdxX(): u32 {
  return marker("threadIdxX");
}
export function threadIdxY(): u32 {
  return marker("threadIdxY");
}
export function threadIdxZ(): u32 {
  return marker("threadIdxZ");
}
export function blockIdxX(): u32 {
  return marker("blockIdxX");
}
export function blockIdxY(): u32 {
  return marker("blockIdxY");
}
export function blockIdxZ(): u32 {
  return marker("blockIdxZ");
}
export function blockDimX(): u32 {
  return marker("blockDimX");
}
export function blockDimY(): u32 {
  return marker("blockDimY");
}
export function blockDimZ(): u32 {
  return marker("blockDimZ");
}
export function gridDimX(): u32 {
  return marker("gridDimX");
}
export function gridDimY(): u32 {
  return marker("gridDimY");
}
export function gridDimZ(): u32 {
  return marker("gridDimZ");
}

// Memory management + copies (host <-> device)
export function deviceMalloc<T>(_len: u32): global_ptr<T> {
  void _len;
  return marker("deviceMalloc");
}
export function deviceFree<T>(_ptr: global_ptr<T>): void {
  void _ptr;
  marker("deviceFree");
}
export function memcpyHtoD<T>(_dst: global_ptr<T>, _src: ref<Vec<T>>): void {
  void _dst;
  void _src;
  marker("memcpyHtoD");
}
export function memcpyDtoH<T>(_dst: mutref<Vec<T>>, _src: global_ptr<T>): void {
  void _dst;
  void _src;
  marker("memcpyDtoH");
}

// Shared memory + barrier
export function sharedArray<T, N extends number>(): shared_ptr<T> &
  (N extends number ? unknown : never) {
  return marker("sharedArray");
}
export function syncthreads(): void {
  marker("syncthreads");
}

// Atomics (minimal set)
export function atomicAdd(_ptr: global_ptr<u32>, _value: u32): u32 {
  void _ptr;
  void _value;
  return marker("atomicAdd");
}
