# Incremental Build Strategy Roadmap (Airplane-Grade)

Goal: reduce rebuild latency without weakening determinism or diagnostics quality.

This is a **design-stage roadmap**. No behavior in this document bypasses current full-check semantics.

Current implementation status:

- Phase A baseline is now partially implemented in `packages/cli/src/internal/commands/build.ts`:
  - deterministic build fingerprint keyed by compiler build id + workspace/project sources
  - cache artifacts at `generated/.build-cache.json` and `generated/.build-cache-state.json`
  - hard fallback to full compile on cache miss/parse mismatch
- Remaining sections below still track the full v2 target.

---

## 1) Invariants (non-negotiable)

- Same input graph + config produces byte-identical generated Rust/CUDA output.
- No stale semantic state reuse across incompatible compiler/bindgen versions.
- Any cache miss or cache uncertainty falls back to full recompute (never best-effort partial reuse).
- Diagnostics remain source-accurate and complete.

---

## 2) Cache layers

1. **Workspace fingerprint cache**
   - Key: compiler version + workspace config hash + project config hash.
   - Purpose: invalidate all downstream cache entries on policy/config changes.

2. **Source unit cache**
   - Key: normalized path + file content hash + resolved-import signature.
   - Value: parsed + validated semantic summary for that source.
   - Rules:
     - cache only post-validation artifacts (never raw partials),
     - include diagnostics-domain schema version in key.

3. **Lowered IR cache**
   - Key: source unit key + dependency trait/union/object-literal shape keys.
   - Value: deterministic Rust IR fragments (module-scoped).
   - Rules:
     - if any dependency key changes, invalidate dependent fragment,
     - merge output ordering stays global and deterministic.

4. **Artifact cache**
   - Key: merged IR hash + backend config hash.
   - Value: generated `main.rs`, CUDA C/PTX text, and metrics snapshot.
   - Rules:
     - no direct rustc/cargo output caching in v1 roadmap phase,
     - generated source identity remains primary cache contract.

---

## 3) Safety gates

- Add `cache.schema` and `compiler.buildId` checks in all cache reads.
- On any decode or schema mismatch: hard cache invalidation + full rebuild.
- Keep explicit cache provenance in `.tsuba/cache/manifest.json`.
- Add cache determinism tests:
  - cold build vs warm build output byte-equality,
  - changed transitive dependency invalidates only required modules,
  - changed compiler/buildId invalidates all entries.

---

## 4) Rollout phases

1. **Phase A (metadata only)**
   - Collect hashes + dependency graph + timings without cache reuse.
   - Validate graph stability and determinism in CI/tests.

2. **Phase B (read-only candidate reuse)**
   - Compute cache hits, but still run full compile and compare candidate reuse output.
   - If mismatch, emit deterministic diagnostic and ignore reuse path.

3. **Phase C (enforced reuse with fallback)**
   - Enable reuse for validated cache entries.
   - Any mismatch or uncertainty falls back to full compile.

4. **Phase D (optional backend incremental hooks)**
   - Evaluate cargo/rustc incremental settings only after Phase C is stable.

---

## 5) Metrics and regression policy

- Reuse existing E2E metrics JSON and perf budget checks.
- Add cache-specific metrics:
  - cache hit rate per fixture/project,
  - cold/warm compile delta,
  - fallback rate due to uncertainty.
- Release blocker: fallback rates must stay deterministic and explainable.
