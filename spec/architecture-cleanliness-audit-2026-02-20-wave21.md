# Architecture Cleanliness Audit (Wave 21)

Date: 2026-02-20  
Scope: utility extraction from compiler host + bindgen parser decomposition + parity evidence expansion.

---

## 1) Summary

Wave 21 improves architecture cleanliness and hardens deterministic source-map span behavior:

1. Compiler host utility/helper logic is extracted into dedicated lowering modules.
2. Bindings-manifest parsing and union lookup logic are extracted from `host.ts`.
3. tsubabindgen parser internals are split out of `pipeline/extract.ts` into a dedicated parser stage file.
4. New architecture and module-level tests lock these boundaries.

This wave is decomposition-first; it avoids language-surface expansion while tightening compiler invariants.

---

## 2) What changed

### 2.1 Compiler host decomposition

Added:

- `packages/compiler/src/rust/lowering/common.ts`
  - shared deterministic helpers:
    - path normalization
    - stable text ordering
    - module/type naming
    - path splitting
    - declaration-key helpers
    - anon-shape name generation
- `packages/compiler/src/rust/lowering/bindings-manifest.ts`
  - marker-specifier/package-root helpers
  - `tsuba.bindings.json` parsing with stable `TSB322x` failure behavior preserved
- `packages/compiler/src/rust/lowering/union-model.ts`
  - alias-key and union lookup helpers (`unionKeyFromType`, identifier/type resolution)

Updated:

- `packages/compiler/src/rust/host.ts`
  - now imports these helpers instead of defining them inline.
  - bindings manifest path/type logic and union lookup helpers are no longer in host-local implementations.

### 2.2 tsubabindgen decomposition

Added:

- `packages/tsubabindgen/src/pipeline/extract-parsers.ts`
  - parser stage internals:
    - type parsing
    - generic param parsing
    - function/struct/enum/trait/impl parsing
    - module declaration parsing

Updated:

- `packages/tsubabindgen/src/pipeline/extract.ts`
  - now focuses on:
    - extractor invocation
    - legacy fallback traversal
    - extracted-output mapping
    - module sorting/orchestration
  - parser internals moved out.

### 2.3 Coverage additions

Added compiler tests:

- `packages/compiler/src/rust/lowering/common.test.ts`
- `packages/compiler/src/rust/lowering/bindings-manifest.test.ts`
- `packages/compiler/src/rust/lowering/union-model.test.ts`

Updated architecture contract test:

- `packages/compiler/src/rust/pass-contracts.test.ts`
  - asserts helper decomposition boundaries (host imports modules, no inline helper definitions).

Updated bindgen architecture test:

- `packages/tsubabindgen/src/architecture.test.ts`
  - now asserts parser internals live in `extract-parsers.ts` (not `extract.ts`).

### 2.4 MIR/source-map hardening

Updated:

- `packages/compiler/src/rust/passes/mir.ts`
  - `emitMirBodyToRustStmtsPass` now supports `fallbackSpanSource` and deterministically backfills missing spans across nested statements/arms.
- `packages/compiler/src/rust/host.ts`
  - host/class function body MIR emission now passes `fallbackSpanSource: bodyRaw`.
  - bumped `COMPILER_BUILD_ID` to invalidate stale deterministic build caches when MIR/source-map behavior changes.
- `packages/compiler/src/rust/passes/main-emission.ts`
  - entry-main MIR emission also passes `fallbackSpanSource: mainBodyRaw`.
- `packages/compiler/src/rust/passes/mir.test.ts`
  - added explicit regression test proving span backfill for return terminators.

---

## 3) Size/shape impact

Measured post-wave:

- `packages/compiler/src/rust/host.ts`: `2851 → 2671` LOC
- `packages/tsubabindgen/src/pipeline/extract.ts`: `809 → 199` LOC
- new parser stage: `packages/tsubabindgen/src/pipeline/extract-parsers.ts` (`625` LOC)

Net effect:

- clearer stage boundaries,
- smaller orchestrator files,
- lower risk of mixed responsibilities in critical entry modules,
- deterministic span preservation for MIR roundtrip output plus safe cache invalidation.

---

## 4) Residual risks and next decomposition target

Still large:

- `packages/compiler/src/rust/host.ts` remains the largest compiler hotspot.

Remaining high-value decomposition for next wave:

1. expression lowering extraction
2. statement lowering extraction
3. item-lowering validation split (class/function/type/interface lowering helpers)

These are the next steps to make `host.ts` primarily orchestration + pass wiring.
