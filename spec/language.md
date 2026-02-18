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

Tsuba infers receiver mutability:

- If method body mutates fields → `&mut self`
- Else → `&self`

If Tsuba cannot infer safely, user can be required to add an explicit marker (TBD).

### 5.3 Constructors

TS `constructor(...)` lowers to `pub fn new(...) -> Self`.

Overloaded constructors are rejected.

---

## 6. Interfaces → traits (nominal)

TS `interface` lowers to Rust `trait`, but Tsuba treats interfaces as **nominal**:

- Implementations require `implements`.
- Structural “duck typing” assignment is rejected.

Generics and `extends` constraints map to Rust trait bounds.

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

---

## 8. Object literals

Object literals are allowed under strict rules.

- If contextual nominal type exists, lower to `Type { ... }`.
- If used as enum variant, lower to variant construction.
- Otherwise, Tsuba may synthesize an anon struct type if it does not escape.

If it escapes in a way that cannot be named deterministically, Tsuba errors.

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

---

## 11. Unsafe and FFI

- `unsafe(() => ...)` lowers to `unsafe { ... }`.
- v0 FFI is minimal; advanced attribute support is planned.

---

## 12. Unsupported TS features (v0)

Hard errors for:

- inheritance (`extends`)
- decorators (unless they are compile-time only markers in `@tsuba/core`)
- TS namespaces
- declaration merging
- conditional types
- `any`
- dynamic indexing without known keys

