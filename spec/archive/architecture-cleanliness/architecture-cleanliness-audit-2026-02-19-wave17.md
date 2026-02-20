# Architecture Cleanliness Audit (Wave 17)

Date: 2026-02-19  
Scope: compiler architecture + release/proof architecture.

---

## 1) Audit summary

### 1.1 Compiler pass topology

- Pass topology is still clean and explicit:
  `bootstrap -> module-index -> file-lowering -> type-models -> annotations -> declaration/main emission -> writer`.
- Contracts are explicit at pass boundaries (`passes/contracts.ts`) and immutable snapshots remain enforced.

### 1.2 Monolith risk check

- `packages/compiler/src/rust/host.ts` remains large (~4k LOC).
- This is currently a **maintainability risk**, not a correctness ambiguity:
  pass boundaries are still enforced, deterministic ordering rules remain explicit, and high-risk regressions are test-covered.
- Recommendation: continue staged extraction from `host.ts` into focused lowering modules without changing pass contracts.

### 1.3 Operational architecture gap (pre-wave)

Before this wave, parity gaps were mostly operational:

- external-proof requirements were not machine-checkable as a category matrix,
- signed-tag policy was documented but not enforced by release scripts,
- diagnostic-quality tracking had broad tests but no release baseline gate.

---

## 2) Hardening added in this wave

1. External proof architecture:
   - added config-driven external proof matrix (`spec/external-proof-matrix.json`),
   - added verifier (`scripts/verify-external-proof.mjs`) with:
     - required-category coverage checks,
     - substantial-target minimum checks,
     - deterministic JSON report output.
2. Release integrity:
   - added signed-tag checker (`scripts/check-signed-head-tag.mjs`),
   - wired publish scripts to require signed-tag presence by default.
3. Diagnostic quality gating:
   - added baseline (`spec/diagnostic-quality-baseline.json`),
   - added checker (`scripts/check-diagnostic-quality.mjs`),
   - wired into `run-all` full unfiltered flow.
4. Traceability enrichment:
   - release traceability now includes `tagsAtCommit`, `signedTagsAtCommit`, and `hasSignedTagAtCommit`.

---

## 3) Residual risks and next architectural actions

1. `host.ts` extraction (maintainability):
   - split expression/type/declaration lowering helpers into dedicated modules,
   - keep pass contracts unchanged during extraction.
2. External proof ecosystem completion:
   - populate sibling proof repos/scripts so `verify-external-proof --require` can run green continuously.
3. Exit-window criteria:
   - 14-day green windows still require elapsed time and ongoing report capture.
