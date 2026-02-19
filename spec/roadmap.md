# Tsuba roadmap (GPU-first, airplane-grade)

This roadmap is organized around **merge gates**: each phase is “done” only when the required test suite passes deterministically.

For the implementation-grade, super-detailed plan used for the next large PR, see:

- `spec/roadmap-v0-language-completion.md`

Tsuba’s primary selling point is **GPU kernels**. GPU is not optional or “later”; it is on the critical path.

“95% TypeScript” in this roadmap means: **95% of the syntax people use in “systems TS”** (strict, typed, no dynamic JS patterns), *not* “any JS program”.
When a TS feature has no Rust-faithful lowering, we hard-error (airplane-grade) rather than emit an approximation.

See also:

- `carryover-from-tsonic.md` (process + architecture to reuse)
- `gpu.md` (kernel dialect + backend direction)

---

## Current status (implemented today)

The repo already has a working v0 scaffold:

- `tsuba init/build/run` exist and are covered by unit + E2E tests.
- `@tsuba/compiler` emits a small, explicitly-whitelisted TS subset to a single Rust `main.rs` and runs `cargo build/run`.
- `@tsuba/core/@tsuba/std/@tsuba/gpu` exist as marker/facade packages.
- GPU kernels are compiled to deterministic CUDA C + PTX (via `nvcc`), and host code can launch kernels via a CUDA driver runtime module (`__tsuba_cuda`).

This roadmap is the plan to take that v0 scaffold to a “real language” implementation.

### Tsonic transfer merge status

- ✅ Checkpoint artifacts are in place:
  - `carryover-from-tsonic.md`
  - `checkpoint-tsonic-2026-02-19.md`
  - `test/scripts/{run-all.sh,run-e2e.sh,typecheck-fixtures.sh}`
- ✅ Merge-gate style test script is adopted with optional fast modes (`--quick`, `--filter`, `--no-unit`) and full-pass gate still required.
- 🔶 Remaining transfer work is concentrated in:
  - `Phase 1.5` (typed IR + deterministic diagnostics + non-silent unsupported-feature reporting),
  - `Phase 3` (bindgen determinism + skip/error reporting),
  - `Phase 8` (publish preflight discipline).

---

## Phase 0 — Lock v0 semantics (spec → checklists) (IN PROGRESS)

Deliverables:

- Expand `gpu.md` with an explicit “kernel dialect” allowed/forbidden list.
- Define the v0 tensor/view contract (dtype/layout/device/strides) that kernels consume.
- Define explicit capability gating (`requires.sm`, tensor-core requirements, atomics availability).
- Define determinism rules for generated artifacts (Rust + PTX + metadata).
- Define the macro/attribute surface (already in `macros.md`) as a strict v0 contract.
- Define the “no duck typing” contract:
  - nominal types by default
  - structural types only in tightly-scoped, spec’d contexts (if any)

Merge gate:

- Spec review complete and frozen for v0.1; all items above are explicit checklists.

---

## Phase 0.5 — Tsonic checkpoint adoption (DONE)

Deliverables:

- Added `checkpoint-tsonic-2026-02-19.md` as a checkpoint reference.
- Enforced phase discipline from Tsonic:
  - parse/resolve/validate/IR/emission/backend boundaries.
  - explicit command/config split in CLI and build orchestration.
- Established checkpoint-required non-code process gates:
  - test/run scripts with filtered iteration + full verification.
  - publish pre-flight pattern (branch sync/version checks/package consistency).

Carryover checks:

- Every non-trivial feature change is mapped to a checkpoint item in `carryover-from-tsonic.md`.
- Any divergence from checkpoint must be explicit and justified in roadmap/spec.

---

## Phase 1 — Repo scaffolding + fast inner loop (DONE)

Deliverables (Tsonic-style monorepo):

- `packages/cli` — `tsuba init/build/run/test/add/bindgen`
- `packages/compiler` — TS parsing, diagnostics, host emission (Rust)
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

Phase 1 additions from checkpoint:

- CLI command structure should follow command/parser/test partitioning used in Tsonic.
- Keep command behavior deterministic even when fixtures are added/removed.

---

## Phase 1.5 — Airplane-grade compiler foundations (NEXT)

Goal: make the compiler architecture provably safe to extend.

Deliverables:

- Introduce a typed internal IR (Rust-ish) for:
  - types (`RustType`)
  - expressions, statements
  - items (functions, structs, impls, traits, enums)
- Introduce a deterministic Rust writer:
  - stable formatting
  - stable ordering rules (files, items, declarations)
  - no ad-hoc string concatenation in converters
- Introduce span tracking + mapping:
  - every IR node has an optional TS span (file+start+end)
  - compiler errors include the originating TS span
  - rustc errors can be mapped back to TS spans where possible
- Add “no silent omission” enforcement:
  - every unsupported TS node must raise a stable `TSBxxxx` error code
  - add tests that assert we error (not skip) on representative unsupported constructs

Merge gate:

- Golden tests assert IR→Rust is deterministic.
- E2E tests still run real `cargo` builds.

Checkpoint additions:

- Keep unsupported constructs as hard errors with stable codes.
- Add explicit diagnostic tests for representative unsupported cases, matching Tsonic’s
  “fail loudly, never hide behavior” principle.

### 1.5a — Tsonic transfer integration checkpoint

Deliverables:

- Add a command-level acceptance matrix:
  - each `tsuba` command has at least one parser test and one behavior test before merge.
- Enforce manifest invariants across CLI + compiler:
  - `tsuba.workspace.json`, `tsuba.json`, `tsuba.bindings.json` roundtrip validation tests.
- Add deterministic output-path tests:
  - same input source and config must produce identical output structure and symbol emission.
- Add explicit skip/error report checks for unsupported constructs instead of implicit approximation.

Merge gate:

- `test/scripts/run-all.sh --no-unit` is used for quick iteration, but no merge is allowed without unfiltered `test/scripts/run-all.sh` pass.
- A new fixture-type diagnostic suite is mandatory for all new unsupported constructs.

---

## Phase 2 — Host compiler MVP (Rust-first subset) (IN PROGRESS)

Deliverables:

- Module resolution via `tsuba.bindings.json`:
  - TS module specifiers → Rust paths + crate identity
  - deterministic import/name resolution rules
- Core lowering:
  - functions, locals, control flow (restricted)
  - blocks, assignments, loops (restricted)
  - indexing + slices (restricted)
  - strings (UTF-8) + formatting macros
  - error model: `Result` is first-class (no exceptions)
  - object/array literals with airplane-grade rules (no “dictionary surprise”):
    1) contextually typed to a known nominal struct → struct construction
    2) otherwise: generate a private “shape struct” with stable name + layout, usable within the module
  - classes → structs
  - interfaces → traits (nominal)
  - discriminated unions → enums + match exhaustiveness
  - `ref<T>`, `mutref<T>` borrowing model
  - `q(Result)` → `?`, `unsafe(() => ...)`
- Diagnostics with stable TS source mapping.

Merge gate:

- Golden tests for representative host programs (Rust output snapshots).
- E2E fixtures: `cargo build` + `cargo run` for a small suite.
- Fixtures also pass vanilla `tsc`.

---

## Phase 3 — tsubabindgen MVP (crate → `.d.ts` + manifest) (TODO)

Deliverables:

- Decide the metadata extraction source of truth (explicit choice required):
  - Option A: nightly `rustdoc -Z unstable-options --output-format json`
  - Option B: rust-analyzer metadata extraction (protocol-driven)
  - Option C: a small Rust helper binary using `cargo metadata` + parsing public source (restricted)
  - (We should not ship something that works “sometimes”; choose one deterministic approach.)
- Emit:
  - `.d.ts` per Rust module
  - curated `index.d.ts`
  - `tsuba.bindings.json` mapping TS module specifiers → Rust paths + crate identity.
- Macro model support (per `macros.md`):
  - function-like macros as values
  - attribute macros as values producing `Attr`
  - derive macros as `DeriveMacro`
  - best-effort skipping, but **no silent omission** (emit a deterministic skip report)

Merge gate:

- Bindgen unit tests for deterministic output.
- At least one real crate facade produced and consumed by an E2E fixture.

---

## Phase 4 — GPU kernel compiler MVP (CUDA/PTX first) (IN PROGRESS)

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

## Phase 5 — “Credibility kernels”: matmul + softmax building blocks (IN PROGRESS)

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

## Phase 6 — MoE dispatch + router building blocks (IN PROGRESS)

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

## Phase 7 — Proof projects + README-smoke discipline (IN PROGRESS)

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

## Phase 8 — Publishing workflow (npm + crates) (TODO)

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

---

## Phase 9 — “95% systems TypeScript” reach (stretch, long-term)

Goal: compile most *strict*, typed TS people write for systems work, while staying Rust-faithful.

Deliverables:

- Async/await (host):
  - decide runtime policy (explicit choice required: no default runtime vs shipped minimal runtime helper)
- Generics + trait bounds (restricted, explicit)
- `match`-first ergonomics for enums/discriminated unions
- Standard library surface that makes “real code” ergonomic without JS patterns:
  - iterators, slices, owned/borrowed strings (`String`/`&str`)
  - collections with explicit ownership

Merge gate:

- A “real” proof project compiles and runs (host + GPU), with no compiler hacks and no silent omissions.
