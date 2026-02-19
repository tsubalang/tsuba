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
- `tsubabindgen.report.json` (deterministic skip report)
- (optional) a bundled crate directory for offline/path-backed consumption

Example:

```
node_modules/@tsuba/axum/
  index.d.ts
  routing.d.ts
  extract.d.ts
  tsuba.bindings.json
  crate/            # optional (when --bundle-crate is used)
```

---

## 2. Airplane-grade rules

- Generation is deterministic.
- Bindgen is **best-effort**:
  - If a public item cannot be represented in Tsuba TS, bindgen **skips** that item.
  - Skips must be **explicit and deterministic** (no silent omission): bindgen emits `tsubabindgen.report.json` listing every skipped item + reason.
- Bindgen must never “guess” a type mapping that could miscompile; when in doubt, skip with a report entry.

Current report shape:

```json
{
  "schema": 1,
  "skipped": [
    { "file": "src/lib.rs", "kind": "type", "snippet": "...", "reason": "..." }
  ]
}
```

---

## 3. Supported Rust surface (v0)

v0 bindgen supports crates whose public API uses a restricted set of types that Tsuba can represent.

### 3.1 Supported items

- `pub struct`
- `pub enum` (unit, tuple-payload, and named-payload variants)
- `pub fn`
- `pub const`
- `pub trait` (method signatures and associated types represented as trait generic parameters)
- inherent/trait `impl` methods (`&self`, `&mut self`, constructors, and generic methods)
- explicit `pub use` re-exports (`name`, `rename`, grouped items)
- exported function-like/attribute/derive proc-macros emitted as marker-compatible TS values

Traits may be supported if they use supported types.

Macros are supported, but only under Tsuba’s TS-valid macro model (see `macros.md`).

Glob re-exports (`pub use module::*`) are intentionally unsupported for v0 facade emission and must appear as explicit `reexport` skip entries in `tsubabindgen.report.json`.

### 3.2 Supported types

v0 focuses on owned, explicit types:

- primitives (`i32`, `u64`, `bool`, `f64`)
- `String` (owned)
- `Str` (borrow-only, Rust `str`)
- `Slice<T>` (borrow-only, Rust `[T]`)
- `Vec<T>`, `Option<T>`, `Result<T,E>`
- selected `std` types (PathBuf, Duration) once facades exist

**References** are supported via marker types in public signatures:

- `&T` → `ref<T>`
- `&mut T` → `mutref<T>`
- `&'a T` → `refLt<"a", T>`
- `&'a mut T` → `mutrefLt<"a", T>`

This keeps Tsuba semantics explicit and avoids hidden allocations.

---

## 4. How bindgen gets metadata

v0 uses a dedicated Rust helper extractor:

- source: `packages/tsubabindgen/rust-extractor`
- parser: `syn`
- invocation: `cargo run --manifest-path packages/tsubabindgen/rust-extractor/Cargo.toml -- <crate-manifest>`
- output: stable JSON IR consumed by `packages/tsubabindgen/src/generate.ts`

This is the required metadata path for v0 (not `rustdoc-json`), chosen for deterministic behavior and stable coverage.

If a Rust module cannot be parsed, extractor must emit an explicit module-scoped `parse` skip issue and generation continues for other modules.

---

## 5. Naming and module layout

Bindgen must produce stable module specifiers.

Recommended:

- One `.d.ts` per Rust module (like Tsonic’s dotnet packages).
- `index.d.ts` as a curated re-export surface.

`tsuba.bindings.json` is the authoritative mapping.

### 5.1 Cargo package vs crate name

Cargo distinguishes between:

- **package name** (`[package] name = "simple-crate"`)
- **crate name** (`[lib] name = "simple_crate"` / Rust `use simple_crate::...`)

In v0, bindgen records both when needed:

- `crate.name`: Rust crate name (used for `use` paths)
- `crate.package` (optional): Cargo package name (used for Cargo dependency resolution when it differs)

---

## 6. tsuba add crate

Tsuba CLI can provide:

- `tsuba add crate axum@0.7.5`

Behavior:

- updates `tsuba.json` for the project (declares the Cargo dependency)
- runs `tsubabindgen` to generate a facade package (`.d.ts` + `tsuba.bindings.json`)
  - output is cached under `.tsuba/bindings-cache/`
  - the generated package is linked into `node_modules/@tsuba/<crate>/` so TypeScript + Tsuba can import it
- enforces a v0 policy of **single version per workspace** per Cargo package

Tsuba does not rely on a curated set of pre-generated crate packages in v0; bindgen is the standard mechanism.

## 6. Bundling crates for offline consumption

If the generated facades are intended to be consumed via npm without requiring crates.io downloads at build time,
bindgen can bundle the crate sources:

- `tsubabindgen ... --bundle-crate`

This emits:

- `tsuba.bindings.json` with `crate.path` (relative path like `./crate`)
- `crate/` containing the crate sources copied from the manifest directory (excluding `target/`, `.git/`, etc)

Tsuba then uses `crate.path` as a Cargo `path` dependency.

---

## 7. Macro + proc-macro support (v0)

Tsuba avoids a curated “blessed macro list”.

Instead, if a crate exports macros/proc-macros and they can be represented under Tsuba’s macro model,
bindgen emits TS values for them.

### 7.1 Function-like macros

Bindgen emits exported function-like macros as branded callable values (e.g. `Macro<...>`).

User code calls them as normal TS calls:

```ts
import { println } from "@tsuba/std/macros.js";
println("hi");
```

Tsuba lowers to:

```rs
println!("hi");
```

If bindgen cannot infer a typed argument model, it must fall back to `Tokens` arguments.

### 7.2 Attribute macros

Bindgen emits exported attribute macros as callable values that produce `Attr` markers.

They are applied to items using `annotate(...)`:

```ts
import { annotate } from "@tsuba/core/lang.js";
import { tokio_main } from "@tsuba/tokio/macros.js";

export async function main(): Promise<void> { /* ... */ }
annotate(main, tokio_main());
```

### 7.3 Derive macros

Bindgen emits derive macros as `DeriveMacro` values that can be attached via `annotate(...)`:

```ts
import { annotate } from "@tsuba/core/lang.js";
import { Serialize, Deserialize } from "@tsuba/serde/index.js";

export class User { id: u64 = 0; }
annotate(User, Serialize, Deserialize);
```

### 7.4 Airplane-grade constraints

- Bindgen must never silently omit a macro: if exported and requested, it is emitted or errors.
- All macro surfaces must be deterministic and stable.
- If a macro would introduce new TS-visible symbols in user code (item-defining macros), v0 should reject it (see `macros.md`).
