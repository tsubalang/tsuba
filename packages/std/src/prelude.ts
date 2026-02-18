// @tsuba/std/prelude.js
// Rust-like prelude facades. These are type-level declarations used by Tsuba.

import type {
  bool,
  i32,
  ref,
  Result,
  Option,
  String,
  u32,
} from "@tsuba/core/types.js";

export type { Option, Result, String };

// Constructors (lowered by the compiler; also usable at runtime for tests/tools)
export function Some<T>(value: T): Option<T> {
  return { some: true, value };
}

export const None: Option<never> = { some: false };

export function Ok<E = never>(): Result<void, E>;
export function Ok<T, E = never>(value: T): Result<T, E>;
export function Ok<T, E = never>(value?: T): Result<T, E> {
  return { ok: true, value: value as T };
}

export function Err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

// Macros
export { println, eprintln } from "./macros.js";

// Collections (minimal v0 surface; can be expanded via bindgen later)
export class Vec<T> {
  readonly #items: T[] = [];

  static new<T>(): Vec<T> {
    return new Vec<T>();
  }

  push(value: T): void {
    this.#items.push(value);
  }

  len(): u32 {
    return this.#items.length as u32;
  }

  get(index: u32): Option<ref<T>> {
    const i = index as number;
    if (i < 0 || i >= this.#items.length) return None;
    return Some(this.#items[i] as ref<T>);
  }
}

export class HashMap<K, V> {
  readonly #map = new Map<K, V>();

  static new<K, V>(): HashMap<K, V> {
    return new HashMap<K, V>();
  }

  len(): u32 {
    return this.#map.size as u32;
  }

  containsKey(key: K): bool {
    return this.#map.has(key);
  }

  get(key: K): Option<ref<V>> {
    if (!this.#map.has(key)) return None;
    // Map#get returns V | undefined; guarded by has()
    return Some(this.#map.get(key)! as ref<V>);
  }

  insert(key: K, value: V): Option<V> {
    if (!this.#map.has(key)) {
      this.#map.set(key, value);
      return None;
    }

    const previous = this.#map.get(key)! as V;
    this.#map.set(key, value);
    return Some(previous);
  }
}

// Common “bottom” helpers (compile-time only; lowered by the compiler)
function bottom(name: string, msg?: String): never {
  const suffix = msg === undefined ? "" : `: ${msg}`;
  throw new Error(`@tsuba/std '${name}'${suffix}`);
}

export function panic(msg?: String): never {
  return bottom("panic", msg);
}

export function todo(msg?: String): never {
  return bottom("todo", msg);
}

export function unreachable(msg?: String): never {
  return bottom("unreachable", msg);
}

// Simple demonstration helper (not required, but useful for smoke tests)
export function parseI32(s: String): Result<i32, String> {
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n)) return Err(`invalid i32: ${s}`);
  return Ok(n as i32);
}
