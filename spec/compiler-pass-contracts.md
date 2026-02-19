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
   - Source: `packages/compiler/src/rust/host.ts` (`bootstrapCompileHost`)
   - Responsibilities:
     - create TS program/checker
     - enforce entry contract (`main`)
     - resolve runtime policy (`none`/`tokio`)
     - collect source files in compilation scope

2. **Semantic harvest pass**
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

3. **Lowering pass**
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

4. **Emission pass**
   - Input: Rust IR
   - Output: `mainRs` text (deterministic)
   - Source:
     - writer: `packages/compiler/src/rust/write.ts`
     - entry: `writeRustProgram(...)`

5. **CLI build orchestration pass**
   - Input: compiler output + workspace/project config
   - Output:
     - generated crate (`Cargo.toml`, `src/main.rs`)
     - optional CUDA/PTX artifacts
   - Source: `packages/cli/src/internal/commands/build.ts`

---

## 2) Contract types (authoritative)

- `CompileHostOptions` / `CompileHostOutput`: `packages/compiler/src/rust/host.ts`
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
- enforced by regression tests:
  - `packages/compiler/src/rust/risk-regressions.test.ts`
  - `packages/compiler/src/rust/write.test.ts`
  - fixture goldens via `test/scripts/run-e2e.sh`
