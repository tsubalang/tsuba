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
- [x] Parse/import graph/resolution/validation/IR/emission/backend remain physically separated (no new mixed paths).
- [x] Each pass has explicit input/output contract types.
- [x] Cross-pass mutation is prohibited except through typed pass outputs.

### A.2 Deterministic lowering
- [x] Same source + config produces byte-identical output in generated Rust/CUDA/manifests.
- [x] Ordering rules are explicit for modules, imports, type declarations, impl blocks, and generated helper names.
- [x] No environment-dependent paths in generated artifacts (except optional debug traces).

### A.3 Miscompile prevention gates
- [x] Every supported syntax shape has a dedicated lowering test.
- [x] Every unsupported syntax shape fails with a stable `TSBxxxx` code.
- [x] Introduce “high-risk transform audit list” with mandatory targeted tests:
  - [x] narrowing-dependent rewrites
  - [x] borrow insertion
  - [x] object-literal contextual lowering
  - [x] union switch/match lowering
  - [x] closure lowering and capture mode

**Exit gate A:** No mixed-pass code paths and no unclassified unsupported constructs.

---

## 4) Workstream B — Type system and semantic coverage (P0/P1)

### B.1 Function and method semantics (P0)
- [x] Full function declaration coverage in supported subset: generics, bounds, async, explicit returns.
- [x] Method receiver semantics (`this`/`ref`/`mutref`) are fully test-covered.
- [x] Closure support matrix is explicit and complete:
  - [x] expression closures
  - [x] move closures
  - [x] block closures (either supported fully or hard-error with dedicated code)

### B.2 Control-flow and narrowing (P0)
- [x] Narrowing rules are explicit and deterministic (no best-effort branching).
- [x] Exhaustive discriminated union handling (`switch`→`match`) has negative tests for non-exhaustive cases.
- [x] Mutation and initialization rules are proven with tests on nested scopes and shadowing.

### B.3 Generics and traits (P0/P1)
- [x] Generic functions/classes/interfaces support documented edge cases.
- [x] Trait method conformance checks include:
  - [x] parameter types
  - [x] return types
  - [x] receiver mutability
  - [x] generic parameter/bound compatibility
- [x] Supertrait and multi-trait implementation matrix covered with runnable fixtures.

### B.4 Objects/classes/unions (P0)
- [x] Object-literal lowering matrix is explicit:
  - [x] contextual nominal target
  - [x] enum variant payload construction
  - [x] synthesized shape structs (scoped, deterministic)
  - [x] hard-error non-representable escape paths
- [x] Class-to-struct lowering has constructor/field/method correctness coverage.

### B.5 Async model (P1)
- [x] Runtime policy (`none`/`tokio`) is fully validated at compile time.
- [x] Async diagnostic coverage includes all prohibited forms (e.g. unsupported Promise chains).
- [x] Runnable async proof fixtures exist for host services/jobs.

**Exit gate B:** Published feature matrix with every supported semantic shape mapped to tests.

---

## 5) Workstream C — Diagnostics quality parity (P0/P1)

### C.1 Stable diagnostic inventory (P0)
- [x] Every compiler error path maps to a registered `TSBxxxx`.
- [x] No raw `throw` escapes user-facing paths without code assignment.
- [x] Diagnostic domain taxonomy remains complete and enforced.

### C.2 Error precision (P1)
- [x] All diagnostics include actionable message + source span.
- [x] rustc mapping is preserved where available and tested.
- [x] Equivalent error shapes are normalized (same cause ⇒ same code/message family).

### C.3 Diagnostic regression harness (P1)
- [x] Add fixture-based “expected diagnostics” snapshots per domain.
- [x] Add negative tests for each newly added feature before merge.

**Exit gate C:** 100% diagnostic-path coverage for supported/unsupported syntax classes.

---

## 6) Workstream D — Bindgen maturity parity (P0/P1)

### D.1 Extractor robustness (P0)
- [x] syn extractor remains primary path; legacy parser only debug-gated.
- [x] Deterministic ordering and normalized paths in reports.
- [x] Parse failures produce explicit skip issues (never silent drop).

### D.2 Surface coverage (P1)
- [x] Traits, impl methods, enums (including payload variants), consts, macros, attributes.
- [x] Generic signatures (functions/structs/traits/methods) preserved where representable.
- [x] Unsupported Rust constructs always appear in `tsubabindgen.report.json`.

### D.3 Cross-crate fidelity (P1)
- [x] Re-export and module-path correctness for nested modules.
- [x] Deterministic behavior on crates with heavy generic and macro usage.
- [x] Bundled crate mode and path-backed mode both verified via CLI integration fixtures.

**Exit gate D:** Two-run byte identity + no unexplained surface loss across advanced fixture set.

---

## 7) Workstream E — CLI/workspace and dependency UX parity (P0/P1)

### E.1 Workspace behavior (P0)
- [x] Commands from any subdirectory correctly target project/workspace root.
- [x] Deterministic resolution between workspace and project config.
- [x] Strict schema checks with stable diagnostics.

### E.2 Dependency operations (P1)
- [x] `add crate`, `add path`, `bindgen` flows fully tested, including package renames.
- [x] Conflict and merge behavior for crate deps/features is deterministic.
- [x] Cargo.toml rendering is stable and idempotent.

### E.3 End-user smoke (P1)
- [x] Clean temp-dir smoke scripts for init/build/run/test/add/bindgen.
- [x] README examples are executable as written.

**Exit gate E:** No manual patching needed for documented workflows.

---

## 8) Workstream F — GPU parity path (P0/P1)

### F.1 Kernel subset completeness (P0)
- [x] Explicitly documented allowed syntax in kernels.
- [x] Deterministic lowering for scalar math, indexing, loops, shared memory, barriers, atomics.
- [x] Strict diagnostics for forbidden kernel constructs.

### F.2 Host↔device integration (P1)
- [x] Launch config validation coverage (`grid`, `block`, dimensions, types).
- [x] Runtime glue verified for allocation/free/copy paths with borrow safety constraints.
- [x] Capability/config mismatch diagnostics are clear and stable.

### F.3 GPU proof kernels (P1)
- [x] Matmul, softmax, MoE-dispatch kernels compile deterministically.
- [x] Correctness checks against CPU references where runtime is available.

**Exit gate F:** Kernel compile and launch workflows are test- and doc-complete.

---

## 9) Workstream G — Test corpus scale-up (P0/P1)

### G.1 Fixture expansion (P0)
- [x] Expand host fixture families beyond minimal samples:
  - [x] generics+traits
  - [x] async runtime
  - [x] union/exhaustiveness
  - [x] object literal edge cases
  - [x] macro/annotate flows
- [x] Every fixture has explicit metadata for expected behavior (`run`, `test`, `expectFailure`).

### G.2 Golden and e2e rigor (P1)
- [x] Golden snapshots for deterministic Rust emit in representative programs.
- [x] E2E includes build+run and optional `cargo test` based on fixture metadata.
- [x] Repo dirtiness gate remains mandatory.

### G.3 Risk-driven regression suites (P1)
- [x] Add dedicated suites for historically risky classes:
  - [x] contextual typing loss
  - [x] narrowing regressions
  - [x] borrow insertion mis-lowering
  - [x] closure capture/typing regressions

**Exit gate G:** Coverage matrix maintained in docs and mapped to tests.

---

## 10) Workstream H — External proof and scale validation (P1)

### H.1 Proof repos (P1)
- [ ] `proof-is-in-the-pudding` verifies a growing, non-trivial set of apps/libs.
- [ ] At least one host-service style project, one GPU-heavy project, one bindgen-heavy project.

### H.2 Large-codebase rehearsal (P1)
- [ ] Compile and run at least 3 substantial real codebases (internal/external).
- [x] Track compile time, memory, and diagnostic quality regressions per release.

### H.3 Release blocking policy (P1)
- [x] Publish scripts require proof verification unless explicitly overridden by maintainer flag.

**Exit gate H:** External proof loop is continuously green and release-blocking.

---

## 11) Workstream I — Release operations parity (P1)

### I.1 Publish invariants
- [x] main-only publish, clean tree, in-sync with origin, version monotonicity, full test gate.
- [x] npm + crates scripts both enforce equivalent preflight discipline.

### I.2 Release traceability
- [x] Automatic changelog notes from merged PR labels.
- [x] Signed tags.
- [x] Reproducible release artifact metadata is generated deterministically.

### I.3 Rollback readiness
- [x] Documented rollback and republish playbook.

**Exit gate I:** Release process is deterministic, auditable, and fail-fast.

---

## 12) Workstream J — Documentation parity (P1)

### J.1 User docs
- [x] “Getting started” docs verified in clean temp dirs.
- [x] Full feature matrix: supported / rejected / planned.
- [x] Error catalog for high-frequency diagnostics.

### J.2 Engineer docs
- [x] Compiler pass contracts documented in one architecture spec.
- [x] Bindgen representability and skip-report semantics documented.
- [x] Testing workflow and gates documented with fast-path + final-path commands.

**Exit gate J:** No undocumented behavior for public user-facing features.

---

## 13) Workstream K — Performance and stability SLOs (P2)

- [x] Track compile latency and memory by fixture class.
- [x] Set and enforce regression budgets in full unfiltered verification (`run-all` + E2E metrics + `check-perf-budgets`).
- [x] Add incremental build strategy roadmap (if needed) without weakening correctness guarantees.

Implementation evidence:

- `test/scripts/run-e2e.sh` emits per-project latency + RSS metrics into `test/fixtures/.tsuba-e2e-metrics.json`.
- `scripts/check-perf-budgets.mjs` enforces latency + RSS budgets from `spec/perf-budgets.json`.
- `spec/incremental-build-roadmap.md` defines staged, fail-safe incremental strategy.

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
- Workspace/config strictness and root-resolution parity are complete (`packages/cli/src/internal/config.ts` + command matrix tests).
- Full Tsonic-grade maturity parity is **not** complete.
- This checklist is the authoritative backlog for closing that gap.
