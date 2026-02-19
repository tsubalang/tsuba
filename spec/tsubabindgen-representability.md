# tsubabindgen Representability and Skip Semantics

This document is the explicit representability contract for `@tsuba/tsubabindgen`.

Goal:

- maximize faithful surface emission for Rust crates,
- never silently drop public API,
- report every skipped shape deterministically.

---

## 1) Pipeline and failure behavior

`tsubabindgen` is a two-stage pipeline:

1. **Extractor** (`packages/tsubabindgen/rust-extractor`)
   - Parses Rust source via `syn`.
   - Emits JSON IR per module.
2. **Generator** (`packages/tsubabindgen/src/generate.ts`)
   - Maps extractor IR to `.d.ts` facades and `tsuba.bindings.json`.
   - Writes `tsubabindgen.report.json` skip report.

Airplane-grade behavior:

- Parse or shape failures are recorded in report entries.
- Generation continues where safe (best-effort), with deterministic omission reporting.
- No silent fallback paths.

---

## 2) What is representable today

### 2.1 Declarations emitted

- public `const`
- public `enum`
- public `struct` (plus inherent methods/constructors)
- public `trait` (methods + supertraits)
- public free functions
- explicit `pub use` item re-exports (`name`, `rename`, grouped items)

### 2.2 Re-export behavior

Supported:

- `pub use crate::mod::Thing;`
- `pub use self::inner::Thing as PublicThing;`
- grouped forms like `pub use inner::{A, B as C};`

Intentionally unsupported (reported):

- glob re-exports (`pub use inner::*;`) → report kind `reexport`

### 2.3 Parse behavior

- If one module fails Rust parsing, that module is emitted with an explicit `parse` skip issue.
- Other modules still generate normally.
- Generation does not abort unless required core metadata is missing.

---

## 3) Skip issue taxonomy

`tsubabindgen.report.json` uses stable `kind` categories to explain omissions.

| Kind | Source stage | Meaning |
| --- | --- | --- |
| `parse` | extractor | Rust module could not be parsed; declarations from that module were skipped |
| `reexport` | extractor/generator | unsupported glob re-export, unresolved source module path, or unresolved source symbol |
| `generic` | extractor/generator | unsupported generic form (e.g. const/lifetime generics in TS facade surface) |
| `param` | extractor/generator | unsupported parameter pattern |
| `type` | generator | Rust type shape not representable in current TS facade model |
| `trait` / `trait-method` | generator | unsupported trait surface shape |
| `impl` | extractor/generator | unsupported impl target or impl member shape |
| `enum` / `struct` / `macro` | extractor/generator | declaration-specific unsupported form |

Notes:

- `kind` is stable and intended for tooling/CI checks.
- `reason` is human-facing and should remain actionable.

---

## 4) Determinism contract

- Module ordering, declaration ordering, and skip report ordering are deterministic.
- Re-export application runs before emission and sorts declaration lists after application.
- Repeated runs on same input must produce byte-identical `.d.ts`, bindings, and report files.
- Skip-report `file` values are crate-root-relative paths (`src/...`) when possible, so reports do not leak machine-local absolute paths.

---

## 5) Coverage and evidence

Primary tests:

- `packages/tsubabindgen/src/generate.test.ts`
  - explicit re-export resolution
  - glob re-export skip reporting
  - parse-failure skip reporting without generation failure
- `test/fixtures/bindgen/@tsuba/reexports`
- `test/fixtures/bindgen/@tsuba/parse-failure`

---

## 6) Change policy

When representability changes:

1. Add fixture(s) showing supported and unsupported shapes.
2. Add deterministic test assertions for emitted `.d.ts` and skip report entries.
3. Update this doc and `spec/feature-matrix.md` in the same PR.
