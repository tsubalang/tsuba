# Tsuba ↔ Tsonic Parity Matrix (Roadmap Baseline)

This document tracks **parity with Tsonic’s engineering discipline** (compiler architecture, diagnostics, testing, release workflow), while preserving intentional language/backend differences:

- Tsuba: Rust-first, GPU-first
- Tsonic: C#/.NET-first

Scope: this is a planning checkpoint, not a marketing checklist.  
Date baseline: **2026-02-19**.

---

## 1) Parity legend

- **P0** = required for airplane-grade v0
- **P1** = required for broad production confidence
- **P2** = quality expansion after v0 gates

Status:

- **Done**: implemented and test-covered in this repo
- **Partial**: implemented but with known architecture/coverage gaps
- **Missing**: not implemented yet

---

## 2) Parity matrix

| Area | Tsonic baseline | Tsuba status | Priority | Evidence | Remaining work |
| --- | --- | --- | --- | --- | --- |
| Workspace-first model | Mandatory workspace, deterministic root/project config | **Done** | P0 | `packages/cli/src/internal/config.ts`, `tsuba.workspace.json`, `tsuba.json` handling in CLI tests | Keep strict schema evolution policy documented |
| CLI command split | Parser/dispatch + command modules + tests | **Done** | P0 | `packages/cli/src/bin.ts`, `packages/cli/src/internal/commands/*` | Expand command-level acceptance matrix in docs |
| Bindgen invocation from CLI | Works in standalone installs (no external binary assumption) | **Done** | P0 | `packages/cli/src/internal/commands/{add,bindgen}.ts` imports `runGenerate` from `@tsuba/tsubabindgen` | Keep packed-install smoke in CI/release script |
| Stable error-code discipline | Hard errors with stable IDs; no silent fallback | **Partial** | P0 | `packages/compiler/src/rust/host.ts` (`TSBxxxx` coverage) | Add centralized code registry + diagnostics fixture matrix by code class |
| Compiler phase layering | Clear parse/resolve/validate/IR/emit/backend boundaries | **Partial** | P0 | Current logic concentrated in `packages/compiler/src/rust/host.ts` | Split into explicit passes and contracts (frontend-like + backend-like separation) |
| Deterministic IR-first emission | Typed IR + deterministic writer, no ad-hoc emit | **Partial** | P0 | `packages/compiler/src/rust/{ir.ts,write.ts}` exists and tested | Complete migration off mixed lowering/emission utilities in host path |
| Generic + trait semantics | Strong generic/constraint validation and lowering | **Done** (host subset) | P0 | Trait/generic tests in `packages/compiler/src/rust/host.test.ts` | Expand edge-case matrix (nested bounds, generic impl collisions) |
| Async + runtime policy | Deterministic async lowering/runtime contract | **Done** (tokio/none policy) | P0 | `runtimeKind` handling in `host.ts`, async tests in `host.test.ts` | Add more E2E fixtures for async crate deps and error surfaces |
| Bindgen determinism and breadth | Robust extractor + deterministic surface + skip reporting | **Partial** | P0 | `packages/tsubabindgen/src/generate.ts`, deterministic tests | Replace regex/source parsing core with robust extractor; grow trait/enum/macro coverage |
| Test harness composition | Unit + fixture typecheck + E2E with filtered loop and full gate | **Done** | P0 | `test/scripts/{run-all.sh,run-e2e.sh,typecheck-fixtures.sh}` | Add explicit dirty-tree guard in run-all |
| Proof-repo verification loop | Separate integration repo (`proof-is-in-the-pudding`) run as gate | **Missing** | P1 | N/A in this repo | Wire external proof repo verify script into release checklist |
| Publish preflight discipline | Branch/sync/clean/version checks before publish | **Missing** | P0 | No `scripts/publish-*.sh` yet in this repo | Add publish scripts with invariant checks before npm/crates publish |
| Docs parity depth | Architecture + user + limitations docs kept current | **Partial** | P1 | `spec/*` exists and is substantial | Keep roadmap/status docs synchronized with implementation after every major merge |

---

## 3) Intentional non-parity (by design)

These are intentional differences and should **not** be treated as gaps:

1. **Backend semantics**
   - Tsonic lowers to C#/.NET; Tsuba lowers to Rust (+ CUDA path).
2. **Error/runtime model**
   - Tsuba prefers Rust `Result` and runtime selection (`none`/`tokio`), not C# async/task semantics.
3. **GPU-first core**
   - Tsuba includes kernel dialect and CUDA/PTX backend as first-class; Tsonic has no equivalent.

---

## 4) Consolidated work plan to parity-grade v0

### P0-A: Compiler architecture hardening

1. Extract clear phases from `host.ts`:
   - parse/import graph
   - symbol/type resolution
   - semantic validation
   - IR construction
   - emission/writer
2. Ensure every unsupported construct fails with stable `TSBxxxx`.
3. Add diagnostics matrix tests by category.

Exit gate:

- No mixed “emit while validating” paths in the core pipeline.
- New unsupported syntax cannot be silently accepted.

### P0-B: Bindgen hardening

1. Replace regex-heavy extraction with a robust parser pipeline.
2. Preserve deterministic ordering.
3. Expand represented public surface:
   - traits (incl. associated-type strategy)
   - enums and impls
   - macros/attrs per `spec/macros.md`.
4. Keep explicit skip reports for unrepresentable constructs.

Exit gate:

- Two runs produce byte-identical bindings.
- No fixture dirtiness and no silent surface loss.

### P0-C: Release discipline

1. Add `scripts/publish-npm.sh` (and crates release script later).
2. Preflight checks:
   - current branch policy
   - clean tree
   - synced with `origin/main`
   - version bumps present
   - full test gate completed

Exit gate:

- Publish command fails fast if invariants are not satisfied.

### P1-D: External proof verification

1. Integrate `proof-is-in-the-pudding` verification into release checklist.
2. Add CI/manual command contract documenting how to run it.

Exit gate:

- Core proof projects build/run against current compiler and bindings.

---

## 5) Definition of “parity complete” for this matrix

Parity is complete when:

1. Every **P0** row in the matrix is **Done**.
2. Remaining **Partial** rows are only P1/P2 enhancements.
3. Intentional non-parity items remain explicitly documented.
4. Roadmap/status docs are updated in the same PR as major architectural changes.
