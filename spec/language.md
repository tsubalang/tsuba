# Tsuba language spec (v0)

This document describes the Tsuba TS subset and its Rust lowering rules.

---

## 1. Source of truth

- Rust semantics are the spec.
- Tsuba must never silently miscompile.
- Tsuba is allowed to reject valid TS.

---

## 2. Modules and naming

### 2.1 ESM imports

Tsuba code uses ESM-style imports:

```ts
import { Vec } from "@tsuba/std/prelude.js";
import { getUser } from "./users.js";
```

### 2.2 File → Rust module mapping

Rust module identifiers cannot contain `-`. Tsuba maps file/module names deterministically:

- `foo-bar.ts` → Rust module `foo_bar`
- `some.dir/name.ts` → nested modules `some_dir::name`

The original TS import specifier remains stable; mapping is internal.

### 2.3 Symbol naming

Tsuba preserves user-authored symbol casing (no auto-renaming). This is deterministic and avoids unstable rename schemes.

Rust idioms (snake_case for functions) are recommended via linting/docs, not enforced by codegen.

---

## 3. Entry points

### 3.1 Binaries

A `bin` project must export `main`:

```ts
export function main(): i32 { return 0; }
```

- `main(): void` lowers to `fn main() {}`
- `main(): i32` lowers to `fn main() { std::process::exit(code) }`

### 3.2 Async main

When runtime is `tokio`, Tsuba supports:

```ts
export async function main(): Promise<void> {
  await serve(...);
}
```

Lowering uses `#[tokio::main]`.

---

## 4. Functions

### 4.1 Parameter passing

Tsuba decides move vs borrow based on parameter types:

- `T` → by-value (move for non-Copy types)
- `ref<T>` → `&T`
- `mutref<T>` → `&mut T`

If the user passes a moved value and later uses it, `rustc` will error.

Tsuba must not auto-clone.

### 4.2 Optional parameters

Optional parameters (`x?: T`) are rejected. Use `Option<T>`.

### 4.3 Default parameters

Default parameters are supported on functions, methods, and arrow closures.

Source:

```ts
function add(x: i32 = 5 as i32): i32 {
  return x;
}
```

Lowering shape:

- signature parameter lowers to `Option<T>`
- call sites lower omitted args as `None`
- call sites lower provided args as `Some(value)`
- function prelude deterministically normalizes with `unwrap_or(defaultExpr)`

This keeps omission behavior explicit in Rust while preserving TS call ergonomics.

---

## 5. Classes → structs

### 5.1 Class declaration

```ts
export class User {
  id: u64 = 0;
  email: String = "";

  setEmail(email: String): void {
    this.email = email;
  }
}
```

Lowers to:

- `pub struct User { pub id: u64, pub email: String }` (privacy follows TS `public`/`private`)
- an `impl User` block for methods

### 5.2 `this` receiver

Tsuba uses an explicit receiver convention:

- If first parameter is `this: mutref<...>` (or `mutrefLt<...>`) → `&mut self`
- If first parameter is `this: ref<...>` (or `refLt<...>`) → `&self`
- If no explicit `this` parameter is provided, receiver defaults to `&self`

This keeps lowering deterministic and avoids hidden mutability inference.

### 5.3 Constructors

TS `constructor(...)` lowers to `pub fn new(...) -> Self`.

Overloaded constructors are rejected.

---

## 6. Interfaces → traits (nominal)

TS `interface` lowers to Rust `trait`, but Tsuba treats interfaces as **nominal**:

- Implementations require `implements`.
- Structural “duck typing” assignment is rejected.

v0 interface rules:

- Members must be method signatures only.
- Method signatures require explicit receiver as first parameter:
  - `this: ref<this>` or `this: mutref<this>`
- `interface A extends B, C` lowers to Rust supertraits (`trait A: B + C`).
- Interface generics and `extends` constraints map to Rust trait bounds.

Trait objects (`dyn Trait`) are v0 optional; if supported, they require an explicit marker type (TBD).

---

## 7. Discriminated unions → enums

Tsuba supports a restricted but powerful subset of discriminated unions.

### 7.1 Supported pattern

- Union of object literals
- A single discriminant property present in all variants
- Discriminant is a literal type (`"foo"`, `"bar"`)

Example:

```ts
export type Shape =
  | { kind: "circle"; r: f64 }
  | { kind: "square"; side: f64 };
```

Lowering:

```rs
pub enum Shape { Circle { r: f64 }, Square { side: f64 } }
```

### 7.2 Narrowing and match

Tsuba lowers:

```ts
switch (s.kind) {
  case "circle": return s.r;
  case "square": return s.side;
}
```

to Rust `match` and enforces exhaustiveness.

If exhaustiveness cannot be proven, Tsuba errors.

### 7.3 Non-union switch

Tsuba also supports scalar-value `switch` statements (non-union discriminants) by lowering them into deterministic `if/else` chains.

v0 restrictions:

- case labels must be literal (`string`, `number`, `boolean`)
- no fallthrough
- each case must end with `break` or `return`

---

## 8. Object literals

Object literals are allowed under strict rules.

- If contextual nominal type exists, lower to `Type { ... }`.
- If used as enum variant, lower to variant construction.
- Otherwise, Tsuba may synthesize an anon struct type if it does not escape.

If it escapes in a way that cannot be named deterministically, Tsuba errors.

### 8.1 Template literals

Interpolated template literals are supported and lower to Rust `format!` calls.

- literal segments are escaped for Rust format-string braces
- interpolations lower as normal expressions
- tagged templates remain unsupported in v0 unless they are explicit macro-marker forms from `@tsuba/core/lang.js`

---

## 9. Error handling

Tsuba strongly prefers `Result` and `Option`.

- `try/catch` is rejected in v0.
- `throw` is rejected.

Use:
- `q(expr)` for `?`
- `panic(...)` for fatal errors

---

## 10. Async

- `async function` lowers to Rust `async fn`.
- `await` lowers to `.await`.

Tsuba rejects `.then(...)` chaining in Tsuba code.

Additional v0 constraints:

- Async functions must declare an explicit `Promise<T>` return type.
- `export async function main` requires `runtime.kind = "tokio"` in `tsuba.workspace.json`.

---

## 11. Unsafe and FFI

- `unsafe(() => ...)` lowers to `unsafe { ... }`.
- `move((...) => expr)` lowers to a Rust `move` closure.
- v0 FFI is minimal; advanced attribute support is planned.

---

## 12. Macros and attributes

Tsuba does not parse Rust `foo!(...)` syntax from TS source.

Instead, macros and attributes are expressed using TS-valid values and intrinsics:

- **function-like macros** are imported as branded callable values (emitted by `tsubabindgen`)
- **attribute macros** are imported as branded callable values that produce an `Attr` marker
- **derive macros** are imported as `DeriveMacro` marker values
- attributes/derives are attached to items using `annotate(...)`

See `macros.md` for the full model.

---

## 13. Unsupported TS features (v0)

Tsuba v0 intentionally omits a significant TS surface.  
The authoritative omission list is:

- `spec/omissions-v0.md`

Core omitted groups include:

- module forms: namespace/default/side-effect imports, barrel re-exports
- expression forms: array/object spread, optional chaining/nullish
- parameter/flow forms: optional params (`x?: T`), destructuring params, `for..of`
- declaration/type forms: class inheritance, TS enums, optional interface members
- advanced async/generator forms: `function*`, `async function*`, `for await`
- type-level TS computation: conditional/mapped/intersection/`infer`, `any`

All omissions must fail deterministically and must not silently lower.
