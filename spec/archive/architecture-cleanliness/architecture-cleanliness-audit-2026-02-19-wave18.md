# Architecture Cleanliness Audit (Wave 18)

Date: 2026-02-19  
Scope: compiler structure + proof/verification architecture.

---

## 1) Summary

### 1.1 Compiler topology

- Pass contracts and ordering remain explicit and unchanged:
  `bootstrap -> module-index -> file-lowering -> type-models -> annotations -> declaration/main emission -> writer`.
- Cross-pass boundaries are still enforced by immutable pass outputs and pass-contract tests.

### 1.2 Monolith risk movement

- `packages/compiler/src/rust/host.ts` was carrying both host lowering and the full CUDA runtime string emitter.
- Wave 18 extracts CUDA runtime text emission into:
  - `packages/compiler/src/rust/cuda-runtime.ts`
- `host.ts` now imports the runtime renderer and focuses on lowering + pass orchestration.
- New contract test guards this boundary so runtime text emission does not regress back into `host.ts`.

### 1.3 Proof architecture hardening

- Required external-proof categories were previously blocked by optional sibling repos.
- Wave 18 introduces required in-repo substantial proof checks:
  - host-service
  - gpu-heavy
  - bindgen-heavy
- `spec/external-proof-matrix.json` now enforces these categories with required checks from repo `.`.
- Sibling `proof-is-in-the-pudding` checks remain in the matrix as optional inputs.

---

## 2) Residual risks

1. `host.ts` remains large (still the primary maintainability hotspot), but boundaries are cleaner than pre-wave due to runtime extraction.
2. `packages/tsubabindgen/src/generate.ts` is still monolithic and should be the next extraction target.
3. Full “14-day green” exit criteria remain time-gated and cannot be closed by one PR.

---

## 3) Recommended next architecture actions

1. Split `tsubabindgen/generate.ts` into parser/resolver/emitter/report modules while preserving deterministic output.
2. Continue staged extraction from `host.ts` (kernel parsing/lowering helpers) with zero contract drift.
3. Keep external proof matrix dual-sourced:
   - required internal substantial checks
   - optional external repo checks for ecosystem growth.
