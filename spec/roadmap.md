# Tsuba roadmap (GPU-first, airplane-grade)

This roadmap is organized around **merge gates**: each phase is “done” only when the required test suite passes deterministically.

Tsuba’s primary selling point is **GPU kernels**. GPU is not optional or “later”; it is on the critical path.

See also:

- `carryover-from-tsonic.md` (process + architecture to reuse)
- `gpu.md` (kernel dialect + backend direction)

---

## Phase 0 — Lock v0 semantics (spec → checklists)

Deliverables:

- Expand `gpu.md` with an explicit “kernel dialect” allowed/forbidden list.
- Define the v0 tensor/view contract (dtype/layout/device/strides) that kernels consume.
- Define explicit capability gating (`requires.sm`, tensor-core requirements, atomics availability).
- Define determinism rules for generated artifacts (Rust + PTX + metadata).
- Define the macro/attribute surface (already in `macros.md`) as a strict v0 contract.

Merge gate:

- Spec review complete; no code yet.

---

## Phase 1 — Repo scaffolding + fast inner loop

Deliverables (Tsonic-style monorepo):

- `packages/cli` — `tsuba init/build/run/test/add/bindgen`
- `packages/frontend` — TS parsing, IR, diagnostics skeleton
- `packages/emitter-host` — Rust host emitter skeleton
- `packages/gpu-backend` — kernel compiler skeleton (compile-only)
- `packages/core` — `@tsuba/core/types.js`, `@tsuba/core/lang.js`
- `packages/std` — `@tsuba/std` minimal prelude facade
- `packages/gpu` — `@tsuba/gpu/types.js`, `@tsuba/gpu/lang.js`

Carryover requirements:

- Add a unified test runner like `tsonic/test/scripts/run-all.sh`:
  - unit + golden tests
  - fixture `tsc` typecheck
  - E2E fixtures (initially host-only)

Merge gate:

- `tsuba init` creates a deterministic workspace.
- `tsuba build` produces Rust for a trivial project and can `cargo build`.
- Unit tests + one tiny E2E fixture pass.

---

## Phase 2 — Host compiler MVP (Rust-first subset)

Deliverables:

- Module resolution via `tsuba.bindings.json`.
- Core lowering:
  - functions, locals, control flow (restricted)
  - classes → structs
  - interfaces → traits (nominal)
  - discriminated unions → enums + match exhaustiveness
  - `ref<T>`, `mutref<T>`, `q(Result)` → `?`, `unsafe(() => ...)`
- Diagnostics with stable TS source mapping.

Merge gate:

- Golden tests for representative host programs (Rust output snapshots).
- E2E fixtures: `cargo build` + `cargo run` for a small suite.
- Fixtures also pass vanilla `tsc`.

---

## Phase 3 — tsubabindgen MVP (crate → `.d.ts` + manifest)

Deliverables:

- Metadata extraction pipeline (v0: `rustdoc-json` acceptable).
- Emit:
  - `.d.ts` per Rust module
  - curated `index.d.ts`
  - `tsuba.bindings.json` mapping TS module specifiers → Rust paths + crate identity.
- Macro model support (per `macros.md`):
  - function-like macros as values
  - attribute macros as values producing `Attr`
  - derive macros as `DeriveMacro`
  - hard error on unrepresentable surfaces (no omission)

Merge gate:

- Bindgen unit tests for deterministic output.
- At least one real crate facade produced and consumed by an E2E fixture.

---

## Phase 4 — GPU kernel compiler MVP (CUDA/PTX first)

Deliverables:

- `kernel(spec, fn)` intrinsic:
  - spec must be compile-time constant (`as const`)
  - kernel bodies are validated against a strict kernel subset
- Minimal GPU intrinsics:
  - thread/block indices
  - global pointers + indexing rules
  - shared memory fixed-size allocation + `syncthreads`
  - atomics (minimal set) with capability gating
- Deterministic CUDA/PTX pipeline:
  - toolchain path pinned in `tsuba.workspace.json`
  - explicit SM target (`sm`)
  - deterministic compilation (no silent fallback)
- Host launcher glue:
  - embed/load PTX
  - explicit launch config

Merge gate:

- Compile-only kernel tests (PTX emitted deterministically).
- GPU correctness tests (if CUDA present):
  - vector add + reduction match CPU reference.

---

## Phase 5 — “Credibility kernels”: matmul + softmax building blocks

Deliverables:

- Shared-memory tiled matmul kernel (baseline).
- Softmax kernel (numerically stable).
- Vectorized loads/stores and basic warp-level primitives (as needed).
- Specialization via `spec.specialize` (tile sizes, vector width).

Merge gate:

- Deterministic correctness suite:
  - CPU reference + tolerance policies.
- Clear diagnostics when spec/capabilities are incompatible.

---

## Phase 6 — MoE dispatch + router building blocks

Deliverables:

- Dispatch kernels:
  - permute/unpermute by expert
  - prefix-sum / offsets helpers (or bind to a library)
- Host-level routing API surface:
  - routeTopK (may be a library op)
  - buildDispatchPlan semantics

Merge gate:

- End-to-end MoE dispatch demo (small).
- Deterministic tests (correctness + stability).

---

## Phase 7 — Proof projects + README-smoke discipline

Deliverables:

- A “proof is in the pudding” repo:
  - host samples, bindgen samples, macros/attrs, GPU kernels
  - verify script that builds + runs deterministically (like Tsonic’s `verify-all.sh`)
- README smoke tests:
  - every “getting started” README is executable as written in a clean temp dir.

Merge gate:

- `run-all.sh` passes unfiltered.
- proof repo verify script passes.

---

## Phase 8 — Publishing workflow (npm + crates)

Deliverables:

- Port Tsonic’s publish discipline:
  - publish from `main`
  - version monotonicity checks
  - PR-based bump branches
- Decide distribution:
  - npm packages for `.d.ts` + manifests + CLI
  - crates.io strategy (if/when we publish Rust runtime crates)

Merge gate:

- Publishing scripts run deterministically and refuse unsafe states.

