# Architecture Cleanliness Audit (Wave 20)

Date: 2026-02-20  
Scope: HIR boundary, MIR body pass, backend source-map isolation, deterministic build-cache foundation.

---

## 1) Summary

Wave 20 moves the compiler/CLI pipeline further toward v2 architecture goals without weakening existing behavior:

1. **HIR boundary is now explicit** between file-lowering and semantic/emission passes.
2. **MIR body pass** is introduced and used for function/method/main body normalization.
3. **Backend source mapping** is isolated into a dedicated compiler module and consumed by CLI.
4. **Deterministic incremental cache layer (Phase A/B baseline)** is implemented in CLI build.

---

## 2) What changed

### 2.1 HIR pipeline

- Added:
  - `packages/compiler/src/rust/passes/hir.ts`
  - `HirDecl` / `HirModule` contracts in `passes/contracts.ts`
- `compileHostToRustImpl` now executes:
  - `collectFileLoweringsPass(...)` → `buildHirModulesPass(...)`
  - downstream passes (`type-models`, `annotations`, `declaration-emission`) now consume HIR.

### 2.2 MIR body pass

- Added:
  - `packages/compiler/src/rust/passes/mir.ts`
  - tests: `packages/compiler/src/rust/passes/mir.test.ts`
- Function/method/main bodies now go through:
  - `lowerRustBodyToMirPass(...)`
  - `emitMirBodyToRustStmtsPass(...)`

### 2.3 Source-map backend isolation

- Added:
  - `packages/compiler/src/rust/source-map.ts`
  - tests: `packages/compiler/src/rust/source-map.test.ts`
- Compiler output now includes structured `sourceMap`.
- CLI writes `generated/src/main.rs.map.json` and uses this mapping when converting rustc spans back to TS.

### 2.4 Deterministic build cache

- CLI build now computes a fingerprint over:
  - compiler build id
  - runtime mode
  - workspace/project TS + config inputs
- Artifacts:
  - `generated/.build-cache.json`
  - `generated/.build-cache-state.json` (hit/miss observability)
- Cache behavior is fail-safe:
  - any parse/schema mismatch or fingerprint mismatch => full rebuild.

---

## 3) Residual architecture risks

1. `packages/compiler/src/rust/host.ts` remains the largest hotspot (still orchestration + major lowering logic).
2. MIR currently normalizes body control-flow but does not yet carry full SSA/dataflow semantics.
3. Cache currently fingerprints workspace/project scope; future work can tighten dependency graph granularity.

---

## 4) Recommended next wave

1. Extract expression/statement lowering from `host.ts` into dedicated lowering modules (`expr`, `stmt`, `item`).
2. Expand MIR into richer CFG/dataflow representation (toward borrow/effect checks as dedicated passes).
3. Add cache determinism suite for cold/warm equivalence under transitive module changes.
