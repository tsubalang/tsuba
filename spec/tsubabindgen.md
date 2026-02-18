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

Macros are supported, but only under Tsuba’s TS-valid macro model (see `macros.md`).

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

- updates `Cargo.toml` for the project (or workspace lockfile)
- runs `tsubabindgen` (or fetches a pre-generated `@tsuba/axum` package)

**Important:** Tsuba should prefer consuming **pre-generated** packages for popular crates.

Bindgen is primarily:

- a tool for internal development
- a power-user tool
- a fallback when no pre-generated package exists

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

If bindgen cannot infer a typed argument model, it must fall back to `Tokens` arguments, or error.

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
