# Architecture Cleanliness Audit (Wave 19)

Date: 2026-02-19  
Scope: compiler GPU-kernel lowering boundaries + tsubabindgen pipeline decomposition.

---

## 1) Summary

### 1.1 Compiler architecture

- `packages/compiler/src/rust/host.ts` was still carrying CUDA kernel-dialect parsing + lowering logic.
- Wave 19 extracted that logic into:
  - `packages/compiler/src/rust/kernel-dialect.ts`
- `host.ts` now only orchestrates kernel collection via a narrow API and keeps pass orchestration responsibilities.

### 1.2 Bindgen architecture

- `packages/tsubabindgen/src/generate.ts` was monolithic (~1800 LOC) and mixed:
  - Rust surface extraction/parsing
  - method/re-export resolution
  - `.d.ts`/manifest/report emission
  - file-system orchestration
- Wave 19 decomposed this into staged modules:
  - `packages/tsubabindgen/src/pipeline/common.ts`
  - `packages/tsubabindgen/src/pipeline/extract.ts`
  - `packages/tsubabindgen/src/pipeline/resolve.ts`
  - `packages/tsubabindgen/src/pipeline/emit.ts`
- `generate.ts` is now orchestration-only (cargo metadata + pipeline wiring + file outputs).

---

## 2) Evidence and guardrails added

1. Compiler boundary contract:
   - `packages/compiler/src/rust/pass-contracts.test.ts` now enforces that kernel-dialect lowering functions are not in `host.ts` and are present in `kernel-dialect.ts`.
2. Bindgen boundary contract:
   - `packages/tsubabindgen/src/architecture.test.ts` enforces:
     - orchestration-only `generate.ts`,
     - parser/resolver/emitter stage separation in dedicated modules.
3. Existing deterministic and functional tests remain green for compiler/CLI/bindgen integration.

---

## 3) Residual risks

1. `packages/compiler/src/rust/host.ts` remains a large file (still a maintainability hotspot), though GPU kernel dialect is now extracted.
2. `pipeline/extract.ts` in tsubabindgen is still the largest stage; additional sub-splitting (parser primitives vs extractor mapping) is possible later.
3. Exit criteria requiring time windows (14-day continuous green) remain inherently time-gated.

---

## 4) Recommended next architecture actions

1. Continue extracting high-density expression/statement lowering helpers from `host.ts` while preserving pass contracts.
2. Split `pipeline/extract.ts` into:
   - parser primitives (`parseType`, `parseParams`, token scanning),
   - rust-extractor mapping,
   - legacy fallback parser.
3. Keep architecture contract tests mandatory for every further decomposition wave.
