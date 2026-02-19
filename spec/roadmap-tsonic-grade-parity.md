# Tsuba → Tsonic-Grade Parity Checklist (Maturity Plan)

This is the **large, execution-grade checklist** for reaching Tsonic-level maturity.

Important distinction:

- `spec/roadmap-parity-with-tsonic.md` = **engineering-discipline baseline parity** (already reached for v0).
- This document = **language coverage, correctness, scale, ecosystem, and operational maturity parity**.

Date baseline: **2026-02-19**.

---

## 0) Definition of “Tsonic-grade parity” for Tsuba

Parity here means:

1. Tsuba compiles a broad, real-world “systems TS” subset at scale (not just curated fixtures).
2. Unsupported features fail with stable diagnostics; supported features are deterministic and miscompile-resistant.
3. Bindgen + CLI + workspace flows are production-grade, with repeatable publish/release operations.
4. Multiple non-trivial external proof repos build and run continuously against current `main`.

Not required for parity:

- Matching C#-specific behavior from Tsonic.
- Matching every TS feature that conflicts with Rust/GPU semantics.

---

## 1) Exit criteria (must all be true)

- [ ] All **P0** and **P1** checklist items in this document are complete.
- [ ] `npm run run-all` is green for 14 consecutive days on `main`.
- [ ] External proof verification is green for 14 consecutive days on `main`.
- [ ] No open “silent miscompile” bug older than 24 hours.
- [ ] At least 3 substantial external projects compile and run against latest release.

---

## 2) Priority legend

- **P0**: blocker for airplane-grade parity.
- **P1**: required for production maturity.
- **P2**: important expansion, not parity-blocking.

Status values for tracking:

- `Missing`, `In Progress`, `Done`, `Deferred (intentional)`.

---

## 3) Workstream A — Compiler architecture hardening (P0)

### A.1 Pass boundaries and ownership
- [ ] Parse/import graph/resolution/validation/IR/emission/backend remain physically separated (no new mixed paths).
- [ ] Each pass has explicit input/output contract types.
- [ ] Cross-pass mutation is prohibited except through typed pass outputs.

### A.2 Deterministic lowering
- [ ] Same source + config produces byte-identical output in generated Rust/CUDA/manifests.
- [ ] Ordering rules are explicit for modules, imports, type declarations, impl blocks, and generated helper names.
- [ ] No environment-dependent paths in generated artifacts (except optional debug traces).

### A.3 Miscompile prevention gates
- [ ] Every supported syntax shape has a dedicated lowering test.
- [ ] Every unsupported syntax shape fails with a stable `TSBxxxx` code.
- [ ] Introduce “high-risk transform audit list” with mandatory targeted tests:
  - [ ] narrowing-dependent rewrites
  - [ ] borrow insertion
  - [ ] object-literal contextual lowering
  - [ ] union switch/match lowering
  - [ ] closure lowering and capture mode

**Exit gate A:** No mixed-pass code paths and no unclassified unsupported constructs.

---

## 4) Workstream B — Type system and semantic coverage (P0/P1)

### B.1 Function and method semantics (P0)
- [ ] Full function declaration coverage in supported subset: generics, bounds, async, explicit returns.
- [ ] Method receiver semantics (`this`/`ref`/`mutref`) are fully test-covered.
- [ ] Closure support matrix is explicit and complete:
  - [ ] expression closures
  - [ ] move closures
  - [ ] block closures (either supported fully or hard-error with dedicated code)

### B.2 Control-flow and narrowing (P0)
- [ ] Narrowing rules are explicit and deterministic (no best-effort branching).
- [ ] Exhaustive discriminated union handling (`switch`→`match`) has negative tests for non-exhaustive cases.
- [ ] Mutation and initialization rules are proven with tests on nested scopes and shadowing.

### B.3 Generics and traits (P0/P1)
- [ ] Generic functions/classes/interfaces support documented edge cases.
- [ ] Trait method conformance checks include:
  - [ ] parameter types
  - [ ] return types
  - [ ] receiver mutability
  - [ ] generic parameter/bound compatibility
- [ ] Supertrait and multi-trait implementation matrix covered with runnable fixtures.

### B.4 Objects/classes/unions (P0)
- [ ] Object-literal lowering matrix is explicit:
  - [ ] contextual nominal target
  - [ ] enum variant payload construction
  - [ ] synthesized shape structs (scoped, deterministic)
  - [ ] hard-error non-representable escape paths
- [ ] Class-to-struct lowering has constructor/field/method correctness coverage.

### B.5 Async model (P1)
- [ ] Runtime policy (`none`/`tokio`) is fully validated at compile time.
- [ ] Async diagnostic coverage includes all prohibited forms (e.g. unsupported Promise chains).
- [ ] Runnable async proof fixtures exist for host services/jobs.

**Exit gate B:** Published feature matrix with every supported semantic shape mapped to tests.

---

## 5) Workstream C — Diagnostics quality parity (P0/P1)

### C.1 Stable diagnostic inventory (P0)
- [ ] Every compiler error path maps to a registered `TSBxxxx`.
- [ ] No raw `throw` escapes user-facing paths without code assignment.
- [ ] Diagnostic domain taxonomy remains complete and enforced.

### C.2 Error precision (P1)
- [ ] All diagnostics include actionable message + source span.
- [ ] rustc mapping is preserved where available and tested.
- [ ] Equivalent error shapes are normalized (same cause ⇒ same code/message family).

### C.3 Diagnostic regression harness (P1)
- [ ] Add fixture-based “expected diagnostics” snapshots per domain.
- [ ] Add negative tests for each newly added feature before merge.

**Exit gate C:** 100% diagnostic-path coverage for supported/unsupported syntax classes.

---

## 6) Workstream D — Bindgen maturity parity (P0/P1)

### D.1 Extractor robustness (P0)
- [ ] syn extractor remains primary path; legacy parser only debug-gated.
- [ ] Deterministic ordering and normalized paths in reports.
- [ ] Parse failures produce explicit skip issues (never silent drop).

### D.2 Surface coverage (P1)
- [ ] Traits, impl methods, enums (including payload variants), consts, macros, attributes.
- [ ] Generic signatures (functions/structs/traits/methods) preserved where representable.
- [ ] Unsupported Rust constructs always appear in `tsubabindgen.report.json`.

### D.3 Cross-crate fidelity (P1)
- [ ] Re-export and module-path correctness for nested modules.
- [ ] Deterministic behavior on crates with heavy generic and macro usage.
- [ ] Bundled crate mode and path-backed mode both verified via CLI integration fixtures.

**Exit gate D:** Two-run byte identity + no unexplained surface loss across advanced fixture set.

---

## 7) Workstream E — CLI/workspace and dependency UX parity (P0/P1)

### E.1 Workspace behavior (P0)
- [ ] Commands from any subdirectory correctly target project/workspace root.
- [ ] Deterministic resolution between workspace and project config.
- [ ] Strict schema checks with stable diagnostics.

### E.2 Dependency operations (P1)
- [ ] `add crate`, `add path`, `bindgen` flows fully tested, including package renames.
- [ ] Conflict and merge behavior for crate deps/features is deterministic.
- [ ] Cargo.toml rendering is stable and idempotent.

### E.3 End-user smoke (P1)
- [ ] Clean temp-dir smoke scripts for init/build/run/test/add/bindgen.
- [ ] README examples are executable as written.

**Exit gate E:** No manual patching needed for documented workflows.

---

## 8) Workstream F — GPU parity path (P0/P1)

### F.1 Kernel subset completeness (P0)
- [ ] Explicitly documented allowed syntax in kernels.
- [ ] Deterministic lowering for scalar math, indexing, loops, shared memory, barriers, atomics.
- [ ] Strict diagnostics for forbidden kernel constructs.

### F.2 Host↔device integration (P1)
- [ ] Launch config validation coverage (`grid`, `block`, dimensions, types).
- [ ] Runtime glue verified for allocation/free/copy paths with borrow safety constraints.
- [ ] Capability/config mismatch diagnostics are clear and stable.

### F.3 GPU proof kernels (P1)
- [ ] Matmul, softmax, MoE-dispatch kernels compile deterministically.
- [ ] Correctness checks against CPU references where runtime is available.

**Exit gate F:** Kernel compile and launch workflows are test- and doc-complete.

---

## 9) Workstream G — Test corpus scale-up (P0/P1)

### G.1 Fixture expansion (P0)
- [ ] Expand host fixture families beyond minimal samples:
  - [ ] generics+traits
  - [ ] async runtime
  - [ ] union/exhaustiveness
  - [ ] object literal edge cases
  - [ ] macro/annotate flows
- [ ] Every fixture has explicit metadata for expected behavior (`run`, `test`, `expectFailure`).

### G.2 Golden and e2e rigor (P1)
- [ ] Golden snapshots for deterministic Rust emit in representative programs.
- [ ] E2E includes build+run and optional `cargo test` based on fixture metadata.
- [ ] Repo dirtiness gate remains mandatory.

### G.3 Risk-driven regression suites (P1)
- [ ] Add dedicated suites for historically risky classes:
  - [ ] contextual typing loss
  - [ ] narrowing regressions
  - [ ] borrow insertion mis-lowering
  - [ ] closure capture/typing regressions

**Exit gate G:** Coverage matrix maintained in docs and mapped to tests.

---

## 10) Workstream H — External proof and scale validation (P1)

### H.1 Proof repos (P1)
- [ ] `proof-is-in-the-pudding` verifies a growing, non-trivial set of apps/libs.
- [ ] At least one host-service style project, one GPU-heavy project, one bindgen-heavy project.

### H.2 Large-codebase rehearsal (P1)
- [ ] Compile and run at least 3 substantial real codebases (internal/external).
- [ ] Track compile time, memory, and diagnostic quality regressions per release.

### H.3 Release blocking policy (P1)
- [ ] Publish scripts require proof verification unless explicitly overridden by maintainer flag.

**Exit gate H:** External proof loop is continuously green and release-blocking.

---

## 11) Workstream I — Release operations parity (P1)

### I.1 Publish invariants
- [ ] main-only publish, clean tree, in-sync with origin, version monotonicity, full test gate.
- [ ] npm + crates scripts both enforce equivalent preflight discipline.

### I.2 Release traceability
- [ ] Automatic changelog notes from merged PR labels.
- [ ] Signed tags and reproducible release artifact metadata.

### I.3 Rollback readiness
- [ ] Documented rollback and republish playbook.

**Exit gate I:** Release process is deterministic, auditable, and fail-fast.

---

## 12) Workstream J — Documentation parity (P1)

### J.1 User docs
- [ ] “Getting started” docs verified in clean temp dirs.
- [ ] Full feature matrix: supported / rejected / planned.
- [ ] Error catalog for high-frequency diagnostics.

### J.2 Engineer docs
- [ ] Compiler pass contracts documented in one architecture spec.
- [ ] Bindgen representability and skip-report semantics documented.
- [ ] Testing workflow and gates documented with fast-path + final-path commands.

**Exit gate J:** No undocumented behavior for public user-facing features.

---

## 13) Workstream K — Performance and stability SLOs (P2)

- [ ] Track compile latency and memory by fixture class.
- [ ] Set and enforce regression budgets in CI.
- [ ] Add incremental build strategy roadmap (if needed) without weakening correctness guarantees.

**Exit gate K:** Performance is measured and regressions are visible before release.

---

## 14) Recommended execution order (single long-drive plan)

1. **A + C + G (P0 first):** harden compiler correctness + diagnostics + risk regression suites.
2. **B + D + E (P0/P1):** expand semantic surface and bindgen fidelity with CLI/workspace integration.
3. **F + H (P1):** GPU and external proof scale-up.
4. **I + J (P1):** release/documentation maturity.
5. **K (P2):** performance SLO discipline.

---

## 15) Tracking table template (for PR checkpoints)

Use this table in each large parity PR:

| Workstream | Item | Priority | Status | Tests Added | Evidence |
| --- | --- | --- | --- | --- | --- |
| A | Example item | P0 | In Progress | host.test.ts + fixture | PR link / file path |

---

## 16) Current reality check (2026-02-19)

- Baseline discipline parity is complete.
- Full Tsonic-grade maturity parity is **not** complete.
- This checklist is the authoritative backlog for closing that gap.
