# Tsuba v0 Omission Matrix (TypeScript Surface)

This is the explicit omission contract for v0.

Policy:

- If a TS feature is not listed as supported in `spec/feature-matrix.md`, it is either:
  - explicitly omitted here, or
  - a bug in documentation and must be added.
- Omitted features must fail deterministically (Tsuba diagnostic or TS pre-emit diagnostic), never silently miscompile.

---

## 1) Imports / modules

| Feature | v0 status | Typical diagnostic |
| --- | --- | --- |
| Side-effect-only imports (`import "./x.js"`) | Omitted | `TSB3206` |
| Default imports (`import x from ...`) | Omitted | `TSB3207` |
| Namespace imports (`import * as ns from ...`) | Omitted | `TSB3209` |
| Barrel re-exports (`export { x } from "./m.js"`, `export * from ...`) | Omitted | `TSB3214` |
| Unknown external package imports | Omitted (must resolve via valid bindings package) | `TSB3211` |

---

## 2) Expressions / objects / collections

| Feature | v0 status | Typical diagnostic |
| --- | --- | --- |
| Array spread (`[...xs]`) | Omitted | `TSB1111` |
| Object spread/rest (`{ ...x }`, object rest patterns) | Omitted | `TSB1118` / `TSB1131` |
| Object-literal methods/getters/setters in structural literals | Omitted | `TSB1119` |
| Untyped escaping object literals | Omitted unless deterministic contextual lowering is possible | `TSB1131` |
| Optional chaining (`?.`) | Omitted in v0 | `TSB1114` |
| Nullish coalescing (`??`) | Omitted in v0 | `TSB1201` |

---

## 3) Functions / parameters / flow

| Feature | v0 status | Typical diagnostic |
| --- | --- | --- |
| Optional/default parameters | Omitted (use explicit `Option<T>`) | `TSB3004` / `TSB4107` / `TSB5109` |
| Untyped function parameters | Omitted (explicit parameter types required) | `TSB3003` |
| Destructuring parameters | Omitted | `TSB3002` / `TSB5107` |
| Generic/block-bodied arrow closures | Omitted in v0 closure subset | `TSB1100` |
| `for..of` loops | Omitted | `TSB2100` |
| `var` in `for` initializer | Omitted | `TSB2120` |
| Discriminated-union `switch` `default` branch | Omitted (must be exhaustive over variants) | `TSB2203` |
| Discriminated-union non-literal case tag expressions | Omitted | `TSB2204` |
| Discriminated-union empty fallthrough cases | Omitted | `TSB2207` |
| Non-union `switch` with non-literal case labels | Omitted | `TSB2211` |
| Non-union `switch` with duplicate case labels | Omitted | `TSB2212` |
| Promise chaining (`.then/.catch/.finally`) | Omitted (`await` only) | `TSB1306` |
| `await` outside async functions | Omitted | `TSB1308` |

---

## 4) Declarations / type system

| Feature | v0 status | Typical diagnostic |
| --- | --- | --- |
| Top-level non-`const` variables | Omitted | `TSB3100` |
| Class inheritance (`extends`) | Omitted | `TSB4002` |
| Class static methods (v0 class subset) | Omitted | `TSB4100` |
| Invalid method receiver typing (must be `ref`/`mutref`) | Omitted | `TSB4105` |
| Constructor optional/default params | Omitted | `TSB4024` |
| TS `enum` declarations | Omitted (use discriminated unions for Rust enums) | `TSB3102` |
| Interface optional members | Omitted | `TSB5104` |
| `any` | Omitted | Spec-level policy (reject) |
| Conditional / mapped / intersection / `infer` type-level computation | Omitted in v0 | Spec-level policy (reject) |

---

## 5) Generators and advanced async

| Feature | v0 status | Typical diagnostic |
| --- | --- | --- |
| Sync generators (`function*`, `yield`) | Omitted | `TSB1010` / unsupported forms |
| Async generators (`async function*`) | Omitted | unsupported forms |
| `for await...of` | Omitted | unsupported forms |

---

## 6) Notes

1. This matrix is intentionally conservative for airplane-grade behavior.
2. When adding support for an omitted feature:
   - add deterministic lowering,
   - add positive and negative matrix tests,
   - update this file and `spec/feature-matrix.md` in the same PR.
