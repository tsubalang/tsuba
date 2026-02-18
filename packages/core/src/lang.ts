// @tsuba/core/lang.js
// Marker functions only. Tsuba erases these at compile time.

import type { Attr, DeriveMacro, Result, Tokens } from "./types.js";

function marker(name: string): never {
  throw new Error(`@tsuba/core: '${name}' is a compile-time marker (not callable at runtime).`);
}

// Rust `?`
export function q<T, E>(_r: Result<T, E>): T {
  return marker("q");
}

// Rust `unsafe { ... }`
export function unsafe<T>(_f: () => T): T {
  return marker("unsafe");
}

// Build a Rust token tree (compile-time only)
// Generic attribute constructor (compile-time only)
export function attr(_name: string, ..._args: readonly Tokens[]): Attr {
  return marker("attr");
}

// Attach attributes / derives to a target item (compile-time only)
export function annotate(
  target: unknown,
  ...items: readonly (Attr | DeriveMacro)[]
): void {
  void target;
  void items;
  marker("annotate");
}

// Build a Rust token tree (compile-time only)
export function tokens(
  _strings: TemplateStringsArray,
  ..._expr: readonly unknown[]
): Tokens {
  return marker("tokens");
}
