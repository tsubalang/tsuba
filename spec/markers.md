# Tsuba marker APIs (`@tsuba/core/types.js`, `@tsuba/core/lang.js`)

Tsuba uses **marker types** and **marker functions** that:

- are valid TypeScript and typecheck in `tsc`.
- are interpreted by the Tsuba compiler.
- are erased / lowered in Rust emission.

Tsuba must not require comments to affect codegen.

---

## 1. Marker types (`@tsuba/core/types.js`)

Marker types are declared as TS aliases so that user code typechecks, but the compiler can lower them to Rust concepts.

### 1.0 Primitive and core Rust types (v0)

Tsuba provides explicit primitive markers (e.g. `i32`, `u32`, `bool`) and a small set of “core Rust” markers:

- `String` → `std::string::String` (owned)
- `Str` → `str` (borrow-only)
- `Slice<T>` → `[T]` (borrow-only)

`Str` and `Slice<T>` are only valid behind borrow markers (`ref`/`mutref`), since `str` and `[T]` are unsized in Rust.

### 1.1 Borrow markers

```ts
export type ref<T> = T;
export type mutref<T> = T;
```

Meaning:

- `ref<T>` lowers to `&T`.
- `mutref<T>` lowers to `&mut T`.

Example:

```ts
import type { ref, mutref, i32 } from "@tsuba/core/types.js";
import { Vec } from "@tsuba/std/prelude.js";

export function sum(xs: ref<Vec<i32>>): i32 {
  // ...
}

export function push(xs: mutref<Vec<i32>>, v: i32): void {
  // ...
}
```

Rust:

```rs
pub fn sum(xs: &Vec<i32>) -> i32 { /* ... */ }
pub fn push(xs: &mut Vec<i32>, v: i32) { /* ... */ }
```

### 1.1.1 Borrowed `Str` and `Slice<T>`

```ts
import type { i32, ref, Slice, Str } from "@tsuba/core/types.js";

export function len(s: ref<Str>): i32 {
  // ...
  return 0 as i32;
}

export function first(xs: ref<Slice<i32>>): i32 {
  return xs[0]!;
}
```

Rust:

```rs
pub fn len(s: &str) -> i32 { /* ... */ }
pub fn first(xs: &[i32]) -> i32 { xs[0] }
```

### 1.2 Lifetime tie markers (v0 optional)

When Rust lifetime elision is insufficient, Tsuba supports explicit lifetime ties:

```ts
export type refLt<L extends string, T> = T;
export type mutrefLt<L extends string, T> = T;
```

Example:

```ts
import type { refLt } from "@tsuba/core/types.js";
import { Vec } from "@tsuba/std/prelude.js";

export function first<L extends string, T>(xs: refLt<L, Vec<T>>): refLt<L, T> {
  return xs.get(0)!;
}
```

Rust:

```rs
pub fn first<'a, T>(xs: &'a Vec<T>) -> &'a T { /* ... */ }
```

### 1.3 Mutability marker (implemented)

Rust requires `mut` bindings to mutate locals. v0 supports an explicit marker:

```ts
export type mut<T> = T;
```

Meaning: `mut<T>` lowers to `let mut` when used in a local declaration.

---

## 2. Marker functions (`@tsuba/core/lang.js`)

### 2.1 `move`

```ts
export declare function move<T extends (...args: any[]) => any>(f: T): T;
```

Meaning: forces Rust `move` closure capture.

```ts
import { move } from "@tsuba/core/lang.js";
import { spawn, println } from "@tsuba/std/prelude.js";

spawn(
  move(() => {
    println("hi");
  })
);
```

Rust:

```rs
spawn(move || { println!("hi"); });
```

v0 restriction:

- `move(...)` must receive exactly one **expression-bodied** arrow function.
- Arrow parameters must be identifier parameters with explicit type annotations.
- Block-bodied arrows in closure position are rejected (hard error).

### 2.2 `unsafe`

```ts
export declare function unsafe<T>(f: () => T): T;
```

Meaning: lowers to Rust `unsafe { ... }` block.

### 2.3 `q` (Rust `?`)

```ts
export declare function q<T, E>(r: Result<T, E>): T;
```

Meaning: lowers to `expr?`.

Rules:

- The enclosing function must return `Result<_, E>` compatible with the `q` expression.
- If Tsuba cannot prove compatibility, it errors.

### 2.4 `panic`, `todo`, `unreachable`

Tsuba provides standard “bottom” markers:

```ts
export declare function panic(msg?: string): never;
export declare function todo(msg?: string): never;
export declare function unreachable(msg?: string): never;
```

They lower to Rust `panic!()`, `todo!()`, `unreachable!()`.

---

## 3. Airplane-grade constraints

- Markers must be explicit in source.
- Tsuba must not insert hidden clones or conversions to “make code compile”.
- Any marker misuse must be a deterministic Tsuba error.
