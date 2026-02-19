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
3. **Semantic harvest pass**
   - Input: `CompileBootstrap`
   - Output:
     - union/type definitions
     - struct/type-alias definitions
     - trait/interface definitions
     - marker annotations
   - Source: `packages/compiler/src/rust/host.ts` (`collect*`, `parseTraitDef`, `parseStructDef`, etc.)
   - Responsibilities:
     - gather nominal semantic entities before statement lowering
     - precompute conformance metadata

4. **Lowering pass**
   - Input: TS AST + harvested semantic context
   - Output: Rust IR (`RustProgram`)
   - Source:
     - `packages/compiler/src/rust/host.ts`
     - IR types: `packages/compiler/src/rust/ir.ts`
   - Responsibilities:
     - deterministic TS→Rust lowering
     - borrow insertion rules
     - class/interface/trait lowering
     - discriminated union lowering
     - kernel extraction + launch lowering

5. **Emission pass**
   - Input: Rust IR
   - Output: `mainRs` text (deterministic)
   - Source:
     - writer: `packages/compiler/src/rust/write.ts`
     - entry: `writeRustProgram(...)`

6. **CLI build orchestration pass**
   - Input: compiler output + workspace/project config
   - Output:
     - generated crate (`Cargo.toml`, `src/main.rs`)
     - optional CUDA/PTX artifacts
   - Source: `packages/cli/src/internal/commands/build.ts`

---

## 2) Contract types (authoritative)

- `CompileHostOptions` / `CompileHostOutput`: `packages/compiler/src/rust/host.ts`
- bootstrap/module-index contracts: `packages/compiler/src/rust/passes/contracts.ts`
- Rust IR:
  - `RustType`, `RustExpr`, `RustStmt`, `RustItem`, `RustProgram`
  - file: `packages/compiler/src/rust/ir.ts`
- Diagnostics registry:
  - `COMPILER_DIAGNOSTIC_CODES`
  - file: `packages/compiler/src/rust/diagnostics.ts`

---

## 3) Mutation rules

- Pass outputs are immutable snapshots by contract.
- Cross-pass mutation is limited to:
  - explicit context maps built in harvesting/lowering (e.g. trait/union maps),
  - deterministic append-only collection inside a pass.
- No hidden global state between compile invocations.

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
