# tsubabindgen (v0)

`tsubabindgen` generates TypeScript facades for Rust crates.

Its job is to let Tsuba users write:

```ts
import { Router } from "@tsuba/axum/index.js";
```

and have the compiler map that import to the Rust path:

```rs
use axum::Router;
```

---

## 1. Outputs

A generated Tsuba package contains:

- `.d.ts` (facade modules)
- `tsuba.bindings.json` (module → Rust path mapping)

Example:

```
node_modules/@tsuba/axum/
  index.d.ts
  routing.d.ts
  extract.d.ts
  tsuba.bindings.json
```

---

## 2. Airplane-grade rules

- Generation is deterministic.
- Missing representation is an error (no silent omission).
- If a public item cannot be represented in Tsuba TS, bindgen errors with an actionable message.

---

## 3. Supported Rust surface (v0)

v0 bindgen supports crates whose public API uses a restricted set of types that Tsuba can represent.

### 3.1 Supported items

- `pub struct`
- `pub enum`
- `pub fn`
- `pub const`

Traits may be supported if they use supported types.

Macros are not supported in bindgen.

### 3.2 Supported types

v0 focuses on owned, explicit types:

- primitives (`i32`, `u64`, `bool`, `f64`)
- `String`
- `Vec<T>`, `Option<T>`, `Result<T,E>`
- selected `std` types (PathBuf, Duration) once facades exist

**References** (`&T`, `&str`) are tricky:

- If an API exposes references in the public surface, bindgen should error in v0.
- The recommended workaround is a small Rust wrapper crate exposing owned types.

This keeps Tsuba semantics explicit and avoids hidden allocations.

---

## 4. How bindgen gets metadata

Tsuba has two viable approaches:

### 4.1 `rustdoc-json`

- Use `rustdoc --output-format json` (may require nightly depending on Rust version).
- Parse the JSON to discover types, functions, module paths.

### 4.2 Source parsing

- Parse the crate’s Rust source with a Rust parser (e.g. `syn`) inside a small Rust helper.
- Emit a stable JSON IR for TS generation.

v0 may start with `rustdoc-json` for speed, then migrate to a stable source-based extractor.

---

## 5. Naming and module layout

Bindgen must produce stable module specifiers.

Recommended:

- One `.d.ts` per Rust module (like Tsonic’s dotnet packages).
- `index.d.ts` as a curated re-export surface.

`tsuba.bindings.json` is the authoritative mapping.

---

## 6. tsuba add crate

Tsuba CLI can provide:

- `tsuba add crate axum@0.7.5`

Behavior:

- updates `Cargo.toml` for the project (or workspace lockfile)
- runs `tsubabindgen` (or fetches a pre-generated `@tsuba/axum` package)

**Important:** Tsuba should prefer consuming **pre-generated** packages for popular crates.

Bindgen is primarily:

- a tool for internal development
- a power-user tool
- a fallback when no pre-generated package exists

