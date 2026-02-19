# Tsuba v0 Feature Matrix (Supported / Rejected / Planned)

This matrix is the executable contract for v0 behavior.

Policy:

- **Supported**: deterministic lowering exists and is test-covered.
- **Rejected**: hard error with stable `TSBxxxx` diagnostic.
- **Planned**: intentionally deferred; not silently approximated.

For the explicit TS omission catalog (user-facing), see:

- `spec/omissions-v0.md`

---

## 1) Entry + expression model

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Entry contract | `export function main()`; `void` and `Result<void, E>` returns; async `main` only with `runtime.kind=tokio` | missing/non-export `main`; invalid main return shapes | broader runtime strategies |
| Closures | expression-bodied arrow closures; `move(...)` arrow closures | block-bodied arrow closures; `move(...)` non-arrow arguments | block-closure lowering |
| Async expressions | `await` in async functions; async lowering to Rust async/await | Promise `.then(...)` chains | additional async combinators |
| Marker calls | `q(...)`, `unsafe(...)`, macro markers, annotate markers (`attr(...)`, `AttrMacro`, `DeriveMacro`) | marker misuse (wrong arity/callee/form) | richer marker libraries |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/diagnostic-matrix.test.ts`
- `packages/compiler/src/rust/diagnostic-fixtures.test.ts`

---

## 2) Functions, classes, traits

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Functions | typed params/returns, generics, generic bounds, deterministic call lowering | optional/default params in unsupported contexts | wider TS function syntax |
| Classes | class → struct+impl lowering, constructors, fields/methods with explicit typing | unsupported class syntax forms | inheritance/extends (deferred) |
| Traits/interfaces | interface → trait, supertraits (`extends`), generic traits, multi-trait impls, trait method conformance checks | optional interface methods; unsupported interface member forms | trait objects / existential strategy |
| Trait method contracts | receiver mutability checks, generic arity/bounds checks, param/return exact-type checks | mismatched method signatures/receivers | relaxed variance rules (if ever) |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/risk-regressions.test.ts`
- `packages/compiler/src/rust/diagnostic-matrix.test.ts`

---

## 3) Control-flow + narrowing

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Basic flow | `if`/`while`/`for` lowering (strict subset), lexical shadowing | unsupported loop/statement shapes outside subset | additional TS control-flow forms |
| Unions | discriminated-union `switch` → `match`, exhaustiveness checks | `switch` default on discriminated unions; non-exhaustive cases; duplicate cases | broader union narrowing surface |
| Mutation discipline | explicit mutability markers + initialization checks | uninitialized locals; non-place mutable borrows | higher-level borrow ergonomics |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/risk-regressions.test.ts`
- `packages/compiler/src/rust/diagnostic-matrix.test.ts`

---

## 4) Type system subset

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Primitive/marker types | Rust scalar aliases, `ref`/`mutref`, slices, fixed-size arrays | unsupported/ambiguous type forms | broader marker/type surface |
| Object literals | contextual nominal lowering; deterministic synthesized shape structs when allowed | non-contextual object literals without explicit type assertions | more inference-friendly object rules |
| Structural typing | explicit nominal-style contracts | structural duck typing as semantic source of truth | none (intentional rejection) |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/risk-regressions.test.ts`
- `packages/compiler/src/rust/diagnostic-fixtures.test.ts`

---

## 5) Imports, bindings, bindgen

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Project imports | deterministic module lowering (`mod` + `use`) for relative project modules | side-effect-only imports | wider import forms if representable |
| External bindings | `tsuba.bindings.json` crate mapping, version/path source tracking, crate dep emission | unsupported/malformed manifests, mapping conflicts | richer manifest metadata |
| tsubabindgen | deterministic generation, payload-enum constructors, traits + impl methods, proc-macro markers (`Macro`, `AttrMacro`, `DeriveMacro`), explicit skip reports, explicit `pub use` re-export resolution, parser-failure skip reporting | silent drop of unsupported constructs; glob re-exports in TS facades | expanded Rust surface coverage |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/diagnostic-matrix.test.ts`
- `packages/tsubabindgen/src/generate.test.ts`

---

## 6) GPU kernel dialect (CUDA/PTX path)

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Kernel declarations | `kernel({ name } as const, (..) => ..)` in top-level consts | invalid kernel declaration forms/names/specs | broader declaration forms |
| Kernel body subset | scalar ops, loops, shared memory, barriers, pointer/index intrinsics, selected math/atomics | non-whitelisted syntax/intrinsics/types | staged expansion after test coverage |
| Host launch path | launch lowering + runtime glue + CUDA PTX compile path; launch config validation for object-literal shape, required `{grid, block}`, and strict 3D dimensions | invalid launch configs or host misuse of kernel-only values | backend expansion beyond CUDA/PTX |

Primary evidence:

- `packages/compiler/src/rust/host.test.ts`
- `packages/compiler/src/rust/diagnostic-matrix.test.ts`
- `test/scripts/run-e2e.sh` + fixture metadata-driven goldens

---

## 7) CLI/workspace contract

| Area | Supported (v0) | Rejected (v0) | Planned |
| --- | --- | --- | --- |
| Workspace/project resolution | nearest-root resolution from nested directories; root-project and packages-project layouts | unresolved roots | none |
| Config parsing | strict `tsuba.workspace.json` / `tsuba.json` schemas (unknown-key rejection) | invalid schema or field shape | schema v2 evolution rules |
| Dependency operations | `add crate`, `add path`, `bindgen`, deterministic cargo dependency merge/render | source conflicts / invalid dep records | additional dep management commands |

Primary evidence:

- `packages/cli/src/internal/config.test.ts`
- `packages/cli/src/internal/commands/*.test.ts`
- `test/scripts/smoke-cli.sh`

---

## 8) How to update this matrix

When adding/changing language behavior:

1. Add/adjust tests first (`host.test.ts`, diagnostic matrix/fixtures, CLI tests as needed).
2. Keep unsupported shapes as explicit `TSBxxxx` diagnostics (no silent approximation).
3. Update this matrix in the same PR with the exact support/reject status and evidence.
