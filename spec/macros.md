# Tsuba macro + attribute model (v0)

Rust uses **macros** and **attributes** heavily. Tsuba must support them in a way that is:

- **TS-valid** (typechecks in `tsc`)
- **scalable** (no curated “blessed macro list”)
- **airplane‑grade** (deterministic lowering; no silent omission; no hidden behavior)

Tsuba therefore does **not** attempt to parse Rust macro syntax (`foo!(...)`) from TS source.
Instead, macros/attributes are represented as **typed values** that the compiler recognizes and lowers to Rust syntax.

---

## 1. Kinds of “macro-like” things in Rust

Tsuba distinguishes three categories:

1) **Function-like macros**: `m!(...)` used as expressions/statements.
2) **Attribute macros**: `#[m(...)]` applied to items (fn/struct/enum/impl/etc).
3) **Derive macros**: `#[derive(D1, D2, ...)]` applied to items.

Tsuba’s TS surface supports all three using **one consistent mechanism**:

- function-like macros are **callable values**
- attribute macros are **callable values that produce an `Attr` marker**
- derive macros are **values of type `DeriveMacro`** that are attached to an item

---

## 2. Marker types (in `@tsuba/core/types.js`)

This spec describes the *shape* of the marker types; exact TS declarations are up to `@tsuba/core`.

### 2.1 Token trees

Some Rust macros accept arbitrary “token trees”.
Tsuba represents these with an opaque marker type:

- `Tokens`

### 2.2 Attributes and derives

- `Attr` — opaque marker representing one Rust `#[...]` attribute instance.
- `DeriveMacro` — opaque marker representing one derive macro name/path inside `#[derive(...)]`.

### 2.3 Macros as values

Tsuba represents macros as branded callable values:

- `Macro<Fn>` — a callable value that lowers to a Rust `name!(...)` invocation.
- `AttrMacro<Fn>` — a callable value that lowers to `#[name(...)]` and returns `Attr`.

Bindgen emits these values for crates that export macros / proc-macros.

---

## 3. Intrinsics (in `@tsuba/core/lang.js`)

### 3.1 `tokens` (compile-time token builder)

Tsuba provides a TS-valid way to build token trees:

```ts
import { tokens } from "@tsuba/core/lang.js";

const t = tokens`serde::Serialize`;
```

Rules (v0):

- The template must be a compile-time constant after interpolation.
- Interpolations must be representable deterministically (literals, known paths, etc).
- If Tsuba cannot lower a `tokens` expression deterministically, it errors.

### 3.2 `attr` (generic Rust attribute constructor)

Rust has many built-in attributes (`repr`, `cfg`, `allow`, etc) and many proc-macro attributes.
Tsuba avoids a curated attribute list by providing a generic constructor:

```ts
import { attr } from "@tsuba/core/lang.js";

const a = attr("repr", tokens`C`);
```

Rules:

- `name` must be a **string literal** in v0.
- Arguments must be deterministic (often `Tokens`, literals, or imported macro markers).

### 3.3 `annotate` (apply attributes/derives to an item)

Because TS has no `#[...]` syntax, Tsuba uses an explicit intrinsic to attach attributes:

```ts
import { annotate, attr, tokens } from "@tsuba/core/lang.js";
import { Serialize, Deserialize } from "@tsuba/serde/index.js"; // DeriveMacro values

export class User { id: u64 = 0; email: String = ""; }

annotate(User, attr("repr", tokens`C`), Serialize, Deserialize);
```

Lowers to Rust:

```rs
#[repr(C)]
#[derive(Serialize, Deserialize)]
pub struct User { /* ... */ }
```

Airplane-grade rules:

- `annotate(target, ...)` is **erased** and must appear in a deterministic location:
  - v0 requires it to appear in the same module, at top level, after the declaration it targets.
- If `target` cannot be resolved to a single Rust item, Tsuba errors.

---

## 4. Using crate-provided macros (no blessed list)

If a crate exports a macro, `tsubabindgen` emits a TS value for it.

### 4.1 Function-like macro call

TS:

```ts
import { println } from "@tsuba/std/macros.js"; // emitted as Macro<...>
println("hi");
```

Rust emission:

```rs
println!("hi");
```

If the macro requires token trees, bindgen may emit it as `(...args: Tokens[]) => ...`,
in which case user code passes `tokens\`...\`` explicitly.

### 4.2 Attribute macro

TS:

```ts
import { annotate } from "@tsuba/core/lang.js";
import { main } from "./main.js";
import { tokio_main } from "@tsuba/tokio/macros.js"; // emitted as AttrMacro<...>

annotate(main, tokio_main());
```

Rust:

```rs
#[tokio::main]
async fn main() { /* ... */ }
```

### 4.3 Derive macros

TS:

```ts
import { annotate } from "@tsuba/core/lang.js";
import { Serialize, Deserialize } from "@tsuba/serde/index.js"; // DeriveMacro values

export class User { id: u64 = 0; }
annotate(User, Serialize, Deserialize);
```

Rust:

```rs
#[derive(Serialize, Deserialize)]
pub struct User { /* ... */ }
```

---

## 5. What is intentionally *not* supported (v0)

Some Rust macros generate **new named items** (e.g. item-definition macros).
Because Tsuba requires TS code to typecheck in `tsc`, Tsuba cannot rely on macro expansion
to introduce new TS-visible symbols.

Therefore, v0 rejects “item-defining macro calls” in Tsuba source.

Workarounds (airplane-grade):

- Use crates where macros expand inside the dependency crate; bindgen sees the expanded public items.
- Write a small Rust wrapper crate that exposes normal structs/enums/fns instead of requiring a macro call in user code.

