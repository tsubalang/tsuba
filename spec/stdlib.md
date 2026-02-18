# Tsuba standard library facades (v0)

Tsuba ships a curated TS facade for Rust `std`.

This is a **language feature**: the facade determines what users can write ergonomically while remaining Rust-faithful.

---

## 1. Packages

- `@tsuba/core` — marker APIs (`lang.js`) and core types.
- `@tsuba/std` — Rust `std` facades.
- `@tsuba/gpu` — GPU kernel authoring + launch facades (CUDA/PTX first).

Optional but expected for “majority use cases”:

- `@tsuba/tokio` — async runtime facade.
- `@tsuba/serde` — serde derive + JSON facade.
- `@tsuba/web` — thin facades over a chosen Rust web stack (likely `axum`).

Likely (but may be split out from `@tsuba/gpu`):

- `@tsuba/tensor` — explicit tensor/view types (dtype/layout/device) built on `@tsuba/gpu`.

---

## 2. `@tsuba/std/prelude.js`

The prelude re-exports the most commonly used types and helpers.

Proposed exports (v0):

- Collections: `Vec<T>`, `HashMap<K,V>`
- Core enums: `Option<T>`, `Result<T,E>`
- Strings: `String`
- Constructors: `Some`, `None`, `Ok`, `Err`
- Logging: `println`, `eprintln`
- Bottom: `panic`, `todo`, `unreachable`

---

## 3. Collections

### 3.1 Vec

A minimal `Vec<T>` facade should cover:

- `new()`
- `push(x)`
- `len()`
- `get(i): Option<ref<T>>` (or `T | undefined` at TS level, but `Option` is preferred)
- `iter(): Iter<ref<T>>`

Tsuba should avoid JS-like array semantics.

---

## 4. Strings

To avoid &str vs String complexity in v0, Tsuba treats TS `String` as Rust `String`.

- String literals used where `String` is expected may lower via `.into()`.

If/when &str is needed, introduce an explicit `Str` borrow facade.

---

## 5. Option / Result

These must behave like Rust:

- Pattern matching should be possible (via `switch` lowering rules).
- The `q(...)` marker must integrate with `Result`.

---

## 6. Async runtime

Tokio is the default proposal for “majority use cases”.

Tsuba’s `async` lowering will:

- generate `#[tokio::main]` for async main.
- use tokio types for timers, tasks, io.

---

## 7. Serde

Serde is required for practical APIs.

Tsuba must provide a compile-time way to request derives:

- `Serialize`
- `Deserialize`

This can be done via a Tsuba attribute DSL (future) or minimal markers.
