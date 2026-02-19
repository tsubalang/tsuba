# Compiler Diagnostics Catalog (High-Frequency)

This document is the operator-facing catalog for Tsuba compiler diagnostics that appear most often in current fixture and matrix coverage.

Policy:

- All user-facing compiler failures must use a registered `TSBxxxx` code.
- Unsupported forms fail explicitly (no silent approximation).
- Diagnostic domains are stable and derived from numeric ranges in `packages/compiler/src/rust/diagnostics.ts`.

---

## 1) Domain map

| Numeric range | Domain |
| --- | --- |
| `TSB0000`–`TSB0999` | bootstrap |
| `TSB1000`–`TSB1999` | entry-and-expressions |
| `TSB2000`–`TSB2999` | control-flow |
| `TSB3000`–`TSB3999` | functions-imports-and-annotations |
| `TSB4000`–`TSB4999` | classes-and-methods |
| `TSB5000`–`TSB5999` | types-and-traits |

---

## 2) High-frequency diagnostics

The list below is intentionally focused on the diagnostics that are repeatedly exercised by `diagnostic-matrix`, `diagnostic-fixtures`, and host regression tests.

### entry-and-expressions

| Code | Meaning |
| --- | --- |
| `TSB1000` | missing exported `main` entrypoint |
| `TSB1003` | async `main` has non-`Promise<void>` return payload |
| `TSB1004` | async `main` requires `runtime.kind=tokio` |
| `TSB1100` | unsupported closure subset usage (generic arrows or non-terminal `return` in block closures) |
| `TSB1114` | optional chaining (`?.`) is rejected in v0 |
| `TSB1303` | `move(...)` requires an inline arrow callback |
| `TSB1306` | Promise `.then(...)` chains are rejected |
| `TSB1308` | `await` used outside async function |
| `TSB1310` | mutable borrow marker used on non-place expression |
| `TSB1201` | nullish coalescing (`??`) is rejected in v0 |
| `TSB1116` | union-variant field accessed without switch-based narrowing |

### control-flow

| Code | Meaning |
| --- | --- |
| `TSB2002` | local variable declared without definite initialization |
| `TSB2120` | `var` declarations inside `for` initializer are rejected |
| `TSB2203` | `default` branch not allowed on discriminated-union switches |
| `TSB2210` | non-exhaustive discriminated-union switch |
| `TSB2211` | non-union switch case label is not a literal |
| `TSB2212` | duplicate non-union switch case label |

### functions-imports-and-annotations

| Code | Meaning |
| --- | --- |
| `TSB3206` | side-effect-only imports are rejected |
| `TSB3214` | export declarations/re-exports are rejected in v0 |
| `TSB3225` | malformed or inconsistent `tsuba.bindings.json` module mapping |
| `TSB3304` | `annotate(...)` item is not `attr(...)`, `AttrMacro(...)`, or `DeriveMacro` |
| `TSB3311` | `annotate(...)` used before declaration |

### classes-and-methods

| Code | Meaning |
| --- | --- |
| `TSB4007` | trait method conformance mismatch (receiver/generics/params/return) |
| `TSB4013` | class field missing explicit type annotation |
| `TSB4024` | optional/default constructor parameters are rejected |

### types-and-traits

| Code | Meaning |
| --- | --- |
| `TSB5104` | optional interface method members are rejected |
| `TSB5110` | interface methods must declare explicit return types |
| `TSB5205` | type alias generic defaults are rejected |
| `TSB5206` | unsupported type-level constructs in type aliases are rejected |

---

## 3) Evidence sources

- `packages/compiler/src/rust/diagnostic-matrix.test.ts`
- `packages/compiler/src/rust/diagnostic-fixtures.test.ts`
- `packages/compiler/src/rust/host.test.ts`

---

## 4) Maintenance contract

When adding/changing diagnostics:

1. Register the code in `packages/compiler/src/rust/diagnostics.ts`.
2. Add/adjust negative tests in matrix/fixtures/host suites.
3. Update this catalog when the new code is high-frequency or operationally important.
