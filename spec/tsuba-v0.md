# Tsuba v0 Spec (Draft)

## 0. Status

This is the **initial** specification for Tsuba.

- Tsuba is a **TypeScript → Rust** compiler.
- Tsuba is **Rust-first**: Rust semantics are the source of truth.
- Tsuba is **airplane-grade**: Tsuba must never silently miscompile.
- Tsuba will intentionally **reject** many valid TypeScript programs.
- Tsuba is **GPU-first**: writing real GPU kernels (CUDA/PTX first) is a v0 requirement.

**Key policy:**
- If Tsuba cannot map a construct to Rust **deterministically**, Tsuba must error.
- Tsuba may rely on `rustc` for ownership/borrow/lifetime diagnostics.
- Tsuba must not “fix” borrow errors by injecting hidden clones/boxes/refs.

---

## 1. Goals

### 1.1 Primary goals

- Let users write Rust programs using TypeScript syntax and tooling.
- Make the result feel like **real Rust** (enums/traits/borrows/async/FFI).
- Make it possible to write **real, high-performance GPU kernels** (FlashAttention-class) from TS (see `gpu.md`).
- Keep the surface syntax within what `tsc` can typecheck.

### 1.2 Non-goals

- Compiling arbitrary JS/TS libraries to Rust.
- Emulating JS runtime semantics (GC objects, prototypes, dynamic maps) unless explicitly modeled.
- Supporting class inheritance (`extends`) in v0.

---

## 2. Project layout and build

### 2.1 Workspaces

Tsuba uses a **workspace** model (like a monorepo).

- Workspace root contains:
  - `tsuba.workspace.json`
  - `packages/` (projects)
  - `crates/` (generated/managed crates; optional)

A project is a package under `packages/<name>/` with:
- `tsuba.json`
- `src/`

### 2.2 Build outputs

For each project, Tsuba produces:
- Rust sources under `packages/<name>/generated/` (or `generated-rs/`)
- A Cargo crate under `packages/<name>/generated-crate/` (or directly in `packages/<name>/`)
- Final artifacts under `packages/<name>/out/` (binary or library)
- When kernels are present: device artifacts (e.g. PTX) plus launch metadata (see `gpu.md`)

Tsuba should be able to:
- `tsuba build` (generate + cargo build)
- `tsuba run` (build + run)
- `tsuba test` (build + cargo test)

### 2.3 Target types

v0 supports:
- `bin` (executable)
- `lib` (rlib / cdylib / staticlib) as explicit config

### 2.4 GPU kernels (v0 must-have)

GPU support is defined in `gpu.md` and includes:

- a kernel dialect embedded in TS via `kernel(spec, fn)` intrinsics
- explicit memory + launch configuration (no hidden transfers)
- CUDA/PTX as the first-class backend

---

## 3. Language subset

Tsuba accepts a strict subset of TypeScript.

### 3.1 Allowed core constructs

- Modules: `import` / `export` (ESM style)
- `export function` → `pub fn`
- `export class` (no `extends`) → `pub struct` + `impl`
- `interface` → `trait` (nominal)
- `type` aliases for:
  - unions used as discriminated enums
  - `Option<T>` / `Result<T,E>` patterns
- `switch` over discriminants → `match`
- `for`, `while` in restricted forms
- `async` / `await` → Rust `async` / `.await` (runtime via configured executor)
- GPU kernel bodies in a restricted kernel dialect (see `gpu.md`)

### 3.2 Forbidden / rejected in v0

Tsuba must error for (non-exhaustive):

- `extends` / prototype inheritance
- `any` (unless explicitly quarantined under marker APIs)
- uncontrolled dynamic property access: `obj[someString]`
- adding properties to objects after construction (`obj.newProp = ...`)
- `eval`, `Function`, etc.
- TS declaration merging / ambient `declare module` hacks
- structural interface assignment as a core feature

---

## 4. Type system mapping

Tsuba’s types are **nominal** at the Rust boundary.

### 4.1 Numeric types

Tsuba provides explicit numeric types via `@tsuba/core/types.js`:

- `i8 i16 i32 i64 isize`
- `u8 u16 u32 u64 usize`
- `f32 f64`
- `bool`

TS `number` is not used as a default numeric type in Tsuba code.

### 4.2 Strings

Tsuba uses an explicit string type:

- `String` (mapped to `std::string::String`)

A JS-like `string` may exist as a TS-level alias but must be carefully controlled. v0 recommends requiring explicit `String`.

### 4.3 Option and Result

Tsuba provides:

- `Option<T>` → `std::option::Option<T>`
- `Result<T,E>` → `std::result::Result<T,E>`

Tsuba provides constructors/facades:
- `Some(x)`, `None`
- `Ok(x)`, `Err(e)`

### 4.4 Never / bottom

TS `never` maps to Rust `!` when it appears in positions where Rust supports it.

### 4.5 Generics

- TS generics map to Rust generics.
- Tsuba rejects conditional types and most advanced TS type-level computation.

---

## 5. Anonymous objects (no structural typing)

Tsuba allows object literals, but **does not** use structural typing as its runtime/ABI contract.

### 5.1 Contextual object literals

If an object literal has an expected nominal type, it lowers to that type.

```ts
export class User { id: u64 = 0; email: String = ""; }

export function mk(): User {
  return { id: 1, email: "a@b" };
}
```

Lowers to:

```rs
pub fn mk() -> User { User { id: 1, email: "a@b".into() } }
```

### 5.2 Discriminated unions (enum variants)

A union of object literals with a string/bool discriminant lowers to a Rust `enum`.

```ts
export type Result<T,E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

Lowers to:

```rs
pub enum Result<T,E> { Ok { value: T }, Err { error: E } }
```

### 5.3 Fresh anon records

If no contextual type exists, Tsuba may synthesize a fresh nominal struct type.

Rules:
- If the value does not escape the block, the anon struct may be block-scoped.
- If it escapes and cannot be named deterministically, Tsuba errors.

---

## 6. Ownership, borrowing, and mutability

Tsuba relies on Rust’s ownership model.

### 6.1 Borrow markers

`@tsuba/core/types.js` defines erased marker types:

- `ref<T>` → `&T`
- `mutref<T>` → `&mut T`

Tsuba infers `&self` / `&mut self` based on method bodies.

### 6.2 Lifetimes

Rust lifetime elision handles many cases, but Tsuba must provide explicit lifetime ties when needed:

- `refLt<"a", T>` → `&'a T`
- `mutrefLt<"a", T>` → `&'a mut T`

Tsuba should surface lifetime parameters as TS string-literal generics.

### 6.3 Mutability

Tsuba uses:
- `let` → `let` (immutable)
- `let` with marker type `mut<T>` OR explicit `mut` marker function → `let mut`

(Exact surface TBD; v0 requires a single obvious mechanism.)

---

## 7. Control flow and pattern matching

### 7.1 `switch` → `match`

Tsuba lowers `switch` on:
- string literal discriminants
- numeric enums (if supported)

to Rust `match` with exhaustiveness enforcement.

If Tsuba cannot prove exhaustiveness, it errors.

### 7.2 Narrowing

TS narrowing constructs are allowed only if Tsuba can lower them soundly.

---

## 8. Functions, closures, and `move`

### 8.1 Arrow functions

Arrow functions lower to Rust closures.

### 8.2 `move`

Tsuba provides a marker function `move(fn)` which forces Rust `move` capture.

```ts
import { move } from "@tsuba/core/lang.js";
spawn(move(() => { println(name); }));
```

---

## 9. `async` / `await`

Tsuba supports `async` functions.

- TS surface type: `Promise<T>` (or a Tsuba alias)
- Rust lowering: `async fn` returning `impl Future<Output = T>`

Tsuba config selects an async runtime (Tokio recommended).

Tsuba should reject `.then(...)` style chaining in Tsuba code.

---

## 10. `unsafe` and FFI

### 10.1 `unsafe` blocks

Tsuba provides `unsafe(() => { ... })` marker which lowers to Rust `unsafe { ... }`.

### 10.2 Rust attributes (future)

Tsuba will need an attribute DSL similar in spirit to Tsonic’s, but emitting Rust attributes:
- `#[repr(C)]`
- `#[no_mangle]`
- `extern "C"`
- `#[derive(...)]` (serde)

In v0, this may be minimal.

---

## 11. Standard library facades (`@tsuba/std`)

Tsuba ships a curated TS facade that maps to `std`:

- `@tsuba/std/prelude.js` (Vec, Option, Result, String, println, etc)
- `@tsuba/std/fs.js`
- `@tsuba/std/io.js`
- `@tsuba/std/time.js`
- `@tsuba/std/net.js` (optional)

These facades are nominal and correspond to real Rust types.

---

## 12. tsubabindgen

`tsubabindgen` generates `.d.ts` facades and a bindings manifest for Rust crates.

### 12.1 Inputs

- A crate (path or registry id + version)
- A configuration file:
  - which modules are public
  - which items are exported
  - rename rules (minimal; prefer faithful)

### 12.2 Outputs

For a crate `my_crate`:

- `node_modules/@tsuba/my-crate/` (or workspace `libs/`)
  - `index.d.ts` + per-module `.d.ts` files
  - `tsuba.bindings.json`

`tsuba.bindings.json` maps TS module specifiers to Rust paths:

```json
{
  "schema": 1,
  "kind": "crate",
  "crate": {
    "name": "my_crate",
    "package": "my-crate",
    "version": "1.2.3"
  },
  "modules": {
    "@tsuba/my-crate/index.js": "my_crate",
    "@tsuba/my-crate/foo.js": "my_crate::foo"
  }
}
```

### 12.3 Design constraints (airplane-grade)

- Generation must be deterministic.
- Bindgen is best-effort, but **must not silently omit**:
  - if a public Rust item cannot be represented in the Tsuba TS surface, bindgen skips it and records the skip deterministically in `tsubabindgen.report.json`.
- Bindgen must never “guess” a type mapping that could miscompile; when in doubt, skip with a report entry.

### 12.4 Generics and traits

tsubabindgen must emit nominal TS surfaces for:
- structs/enums
- trait methods (when representable)
- generic functions (when representable)

It should not attempt to model every Rust feature in v0 (e.g. higher-kinded types). Unsupported surfaces are expected to be skipped with explicit reporting.

---

## 13. Diagnostics

Tsuba diagnostics must be:
- deterministic
- stable across runs
- actionable

Rust errors should be surfaced with the generated Rust snippet location and original TS location mapping.

---

## 14. CLI (proposed)

- `tsuba init`
- `tsuba build`
- `tsuba run`
- `tsuba test`
- `tsuba add crate <name>@<version>`
- `tsuba add path <path-to-crate>`
- `tsuba bindgen <crate>` (low-level)

---

## 15. v0 scope checklist

Must-have for “majority Rust use cases”:

- GPU kernel dialect (CUDA/PTX first) with shared memory + barriers + atomics
- enums + match
- traits + impl
- Option/Result + ?
- Vec/HashMap/String
- async/await (Tokio)
- serde derive (at least JSON)
- safe FFI/unsafe surface (minimal)

Hard errors are acceptable when semantics can’t be made Rust-faithful.
