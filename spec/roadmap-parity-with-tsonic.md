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
| Stable error-code discipline | Hard errors with stable IDs; no silent fallback | **Done** | P0 | `packages/compiler/src/rust/{host.ts,diagnostics.ts,diagnostic-matrix.test.ts}` enforces code registration and domain-level diagnostics coverage | Expand matrix breadth as new syntax lands |
| Compiler phase layering | Clear parse/resolve/validate/IR/emit/backend boundaries | **Done** | P0 | `bootstrapCompileHost`, `createEmitCtx`, `collectSortedKernelDecls`, `createUserModuleIndex` + explicit phase staging in `compileHostToRust` | Keep extracting smaller phase modules as compiler surface grows |
| Deterministic IR-first emission | Typed IR + deterministic writer, no ad-hoc emit | **Done** | P0 | `packages/compiler/src/rust/{ir.ts,write.ts}` + host emitter tests enforce deterministic typed IR → Rust rendering | Maintain writer-only Rust emission discipline for new features |
| Generic + trait semantics | Strong generic/constraint validation and lowering | **Done** (host subset) | P0 | Trait/generic tests in `packages/compiler/src/rust/host.test.ts` | Expand edge-case matrix (nested bounds, generic impl collisions) |
| Async + runtime policy | Deterministic async lowering/runtime contract | **Done** (tokio/none policy) | P0 | `runtimeKind` handling in `host.ts`, async tests in `host.test.ts` | Add more E2E fixtures for async crate deps and error surfaces |
| Bindgen determinism and breadth | Robust extractor + deterministic surface + skip reporting | **Done** | P0 | `packages/tsubabindgen/rust-extractor` (syn-based extractor) + `generate.ts` mapping + advanced fixture coverage (`simple`, `traits`, `advanced`) | Keep adding fixtures for newly-supported Rust surfaces |
| Test harness composition | Unit + fixture typecheck + E2E with filtered loop and full gate | **Done** | P0 | `test/scripts/{run-all.sh,run-e2e.sh,typecheck-fixtures.sh}` | Keep fixture corpus expanding with new features |
| Proof-repo verification loop | Separate integration repo (`proof-is-in-the-pudding`) run as gate | **Done** | P1 | `scripts/verify-proof.sh` + `npm run verify:proof`; `scripts/publish-npm.sh` runs proof in required mode by default | Keep proof corpus expanding with language coverage |
| Publish preflight discipline | Branch/sync/clean/version checks before publish | **Done** | P0 | `scripts/publish-npm.sh` + `scripts/publish-crates.sh` enforce branch/sync/clean/full-test/version checks | Add signed release notes/tag automation |
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

### P0-A: Compiler architecture hardening (**Completed for v0 baseline**)

1. Keep explicit phases in `host.ts`:
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

### P0-B: Bindgen hardening (**Completed for v0 baseline**)

1. Keep the syn-based Rust extractor (`packages/tsubabindgen/rust-extractor`) as the primary metadata source.
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

1. Maintain `scripts/publish-npm.sh` and `scripts/publish-crates.sh` with parity invariants.
2. Preflight checks:
   - current branch policy
   - clean tree
   - synced with `origin/main`
   - version bumps present
   - full test gate completed
   - proof verification required by default for npm publish flow

Exit gate:

- Both publish commands fail fast if invariants are not satisfied.

### P1-D: External proof verification

1. Keep `proof-is-in-the-pudding` verification integrated in release preflight.
2. Keep manual command contract and docs synchronized as the proof corpus grows.

Exit gate:

- Core proof projects build/run against current compiler and bindings.

---

## 5) Definition of “parity complete” for this matrix

Parity is complete when:

1. Every **P0** row in the matrix is **Done**.
2. Remaining **Partial** rows are only P1/P2 enhancements.
3. Intentional non-parity items remain explicitly documented.
4. Roadmap/status docs are updated in the same PR as major architectural changes.

Current checkpoint (2026-02-19): conditions 1–4 are satisfied for the current v0 matrix.
