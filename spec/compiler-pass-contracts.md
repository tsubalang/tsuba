# Compiler Pass Contracts (v0)

This document is the pass-level contract for `@tsuba/compiler`.

Airplane-grade rule:

- each pass has explicit inputs/outputs,
- unsupported shapes fail with `TSBxxxx`,
- no silent fallback paths.

---

## 1) Pass graph

1. **Bootstrap pass**
   - Input: `CompileHostOptions`
   - Output: `CompileBootstrap`
   - Source: `packages/compiler/src/rust/passes/bootstrap.ts` (`runBootstrapPass`)
   - Responsibilities:
     - create TS program/checker
     - enforce entry contract (`main`)
     - resolve runtime policy (`none`/`tokio`)
     - collect source files in compilation scope

2. **Module index / import resolution pass**
   - Input: user source file set + entry filename
   - Output: `UserModuleIndex` + resolved relative import targets
   - Source: `packages/compiler/src/rust/passes/module-index.ts`
   - Responsibilities:
     - deterministic source-file → Rust-module mapping
     - collision diagnostics for module names
     - strict relative import target resolution
3. **File lowering pass**
   - Input: user source file set + module index + import metadata
   - Output: `Map<fileName, FileLowered>`
   - Source: `packages/compiler/src/rust/passes/file-lowering.ts`
   - Responsibilities:
     - top-level declaration bucketing (classes/functions/types/interfaces)
     - import lowering (`use` synthesis)
     - annotate marker harvesting
     - package bindings manifest resolution (`tsuba.bindings.json`)
4. **HIR normalization pass**
   - Input: `Map<fileName, FileLowered>`
   - Output: `Map<fileName, HirModule>`
   - Source: `packages/compiler/src/rust/passes/hir.ts`
   - Responsibilities:
     - normalize declaration ordering per module
     - preserve immutable module snapshots for downstream passes

5. **Type-model collection pass**
   - Input: lowered files
   - Output: populated semantic model maps (unions/struct aliases/traits)
   - Source: `packages/compiler/src/rust/passes/type-models.ts` + host callbacks
   - Responsibilities:
     - collect semantic definitions before statement lowering
     - preserve deterministic declaration traversal
6. **Annotation validation pass**
   - Input: lowered files + semantic model presence + entry metadata
   - Output: `Map<fileName, Map<target, attrs[]>>`
   - Source: `packages/compiler/src/rust/passes/annotations.ts`
   - Responsibilities:
     - enforce declaration-after-annotate ordering
     - ensure annotate targets exist and are representable
7. **Declaration emission pass**
   - Input: lowered files + module index + attrs map + semantic context
   - Output: deterministic Rust IR declaration items + root attrs
   - Source: `packages/compiler/src/rust/passes/declaration-emission.ts`
   - Responsibilities:
     - emit module/root uses and declaration groups in source order
     - emit deterministic synthesized shape structs per file
8. **MIR body pass**
   - Input: lowered Rust statement lists for function/method/main bodies
   - Output: `MirBody` CFG snapshots + normalized Rust statement replay
   - Source: `packages/compiler/src/rust/passes/mir.ts`
   - Responsibilities:
     - create explicit body control-flow snapshots
     - preserve deterministic body normalization before emit

9. **Main emission pass**
   - Input: entry `main`, runtime policy, root attrs, semantic context
   - Output: entry-root shape structs + `main` Rust item
   - Source: `packages/compiler/src/rust/passes/main-emission.ts`
   - Responsibilities:
     - lower entry body statements with async policy
     - emit deterministic root shape structs and `main` attributes

10. **Writer emission pass**
   - Input: Rust IR
   - Output: `mainRs` text (deterministic)
   - Source:
     - writer: `packages/compiler/src/rust/write.ts`
     - entry: `writeRustProgram(...)`

11. **Rust source-map pass**
   - Input: generated `mainRs` text
   - Output: `RustSourceMap` (`main.rs` line → TS span)
   - Source: `packages/compiler/src/rust/source-map.ts`

12. **CLI build orchestration pass**
   - Input: compiler output + workspace/project config
   - Output:
     - generated crate (`Cargo.toml`, `src/main.rs`)
     - generated source-map artifact (`src/main.rs.map.json`)
     - optional CUDA/PTX artifacts
   - Source: `packages/cli/src/internal/commands/build.ts`

---

## 2) Contract types (authoritative)

- `CompileHostOptions` / `CompileHostOutput`: `packages/compiler/src/rust/host.ts`
- pass contracts (`CompileBootstrap`, `UserModuleIndex`, `FileLowered`, etc.):
  - includes `HirDecl`, `HirModule`
  - `packages/compiler/src/rust/passes/contracts.ts`
- Rust IR:
  - `RustType`, `RustExpr`, `RustStmt`, `RustItem`, `RustProgram`
  - file: `packages/compiler/src/rust/ir.ts`
- MIR:
  - `MirBody`, `MirBlock`, `MirTerminator`
  - file: `packages/compiler/src/rust/passes/mir.ts`
- Diagnostics registry:
  - `COMPILER_DIAGNOSTIC_CODES`
  - file: `packages/compiler/src/rust/diagnostics.ts`

### 2.1 Host helper decomposition (non-pass modules)

To keep host orchestration clean, these helper modules are intentionally separate:

- `packages/compiler/src/rust/lowering/common.ts`
  - deterministic naming/path/order helpers
- `packages/compiler/src/rust/lowering/bindings-manifest.ts`
  - `tsuba.bindings.json` discovery/parsing helpers
- `packages/compiler/src/rust/lowering/union-model.ts`
  - alias key + union lookup helpers

These are not pipeline passes; they are pass-local utility boundaries that reduce host monolith risk.

---

## 3) Mutation rules

- Pass outputs are immutable snapshots by contract.
- Cross-pass mutation is limited to:
  - explicit context maps built in harvesting/lowering (e.g. trait/union maps),
  - deterministic append-only collection inside a pass.
- No hidden global state between compile invocations.
- Snapshot wrappers are mandatory at pass boundaries:
  - map outputs use `asReadonlyMap(...)` (copy-on-return + no mutators),
  - collection outputs use `freezeReadonlyArray(...)`,
  - per-file lowered records are `Object.freeze(...)`-wrapped.

---

## 4) Failure model

- User-facing compile failures must throw `CompileError` with registered `TSBxxxx`.
- Registry validity is enforced by tests:
  - `packages/compiler/src/rust/diagnostics.test.ts`
- Unsupported syntax must fail explicitly; no best-effort semantic approximation.

---

## 5) Determinism invariants

- same source/config ⇒ byte-identical Rust output
- deterministic ordering for:
  - modules/imports
  - declarations
  - helper/generated names
- explicit ordering rules:
  - `use` items sorted by `path` then `alias`
  - non-entry modules sorted by normalized file key
  - declaration groups emitted in source order within each module
  - synthesized shape structs sorted by construction span then stable key
  - crate dependency list sorted by crate name
- span comments use entry-relative source paths (never machine-local absolute roots in generated Rust)
- enforced by regression tests:
  - `packages/compiler/src/rust/risk-regressions.test.ts`
  - `packages/compiler/src/rust/write.test.ts`
  - `packages/compiler/src/rust/host.test.ts` (ordering checks)
  - fixture goldens via `test/scripts/run-e2e.sh`
