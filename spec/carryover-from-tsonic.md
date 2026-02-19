# Carryover from Tsonic (design + process)

This document summarizes what we should carry over from the existing **Tsonic** ecosystem (repos under `~/repos/tsoniclang/`) when building **Tsuba**.

Tsuba is not “Tsonic with a different backend” — it is GPU-first and Rust-first — but many *process* and *tooling* decisions in Tsonic are directly reusable and are already proven to prevent drift and miscompile risk.

## 0) Checkpoint policy

- We track a pinned checkpoint in:
  - `checkpoint-tsonic-2026-02-19.md`
- Scope rule:
  - carry over structure/process/quality patterns from Tsonic,
  - do not copy semantic assumptions that are C#/.NET-specific.
- The default for divergence is: implement in a Tsuba-faithful way and document the intentional difference.

## 0.1) 2026-02-19 audit baseline

I performed a full-source inventory of Tsonic and found:

- `packages/` directory has **2195 files** with strong compiler ownership in:
  - `packages/frontend/src` (**182 files**),
  - `packages/emitter/src` (**154 files**),
  - `packages/cli/src` (**38 files**),
  - `packages/backend/src` (**9 files**).
- `docs/` has **33 files** (architecture + language + command docs + caveats).
- `test/fixtures` plus generated outputs is very large (~53k files), so the carryover analysis focuses on source/test harness boundaries.
- `scripts/` has **7 files** including publish and invariant enforcement.
- `test/scripts/` has **3 files** (`run-all`, `run-e2e`, fixture typecheck flow).

This matters because most Tsonic transfer value is in **architecture + validation discipline** (not raw file parity).

## 0.2) How this transfer is merged

- `carryover-from-tsonic.md` gives what to carry.
- `spec/roadmap.md` carries execution status in phases.
- `spec/checkpoint-tsonic-2026-02-19.md` is the immutable snapshot used when a phase diverges.
- `test/scripts/*` (in this repo) holds the same layered verification pattern:
  - unit/golden-style tests,
  - tsc typecheck gate,
  - E2E build gate,
  - final full-filterless run-all before release.

---

## 1) Repo + package layout (monorepo compiler)

**Tsonic reference**

- `~/repos/tsoniclang/tsonic/packages/` contains the compiler as a monorepo split into:
  - `frontend/` (TS parsing + IR + validation)
  - `emitter/` (C# emission, golden tests)
  - `backend/` (build orchestration / project generator)
  - `cli/` (init/build/run/add/restore)

Key inspection points:

- `~/repos/tsoniclang/tsonic/packages/frontend/src/`
- `~/repos/tsoniclang/tsonic/packages/emitter/src/`
- `~/repos/tsoniclang/tsonic/packages/backend/src/`
- `~/repos/tsoniclang/tsonic/packages/cli/src/commands/`

**Carryover to Tsuba**

- Use the same coarse architecture:
  - `packages/frontend/` (shared TS frontend: resolver, IR, diagnostics)
  - `packages/emitter-host/` (Rust host emission + golden tests)
  - `packages/backend/` (Cargo build orchestration + artifact layout)
  - `packages/gpu-backend/` (CUDA/PTX kernel compiler + metadata)
  - `packages/cli/` (tsuba init/build/run/test/add/bindgen)

Rationale:

- Tsonic’s separation keeps backend-specific decisions contained (airplane-grade).
- The TS frontend can remain largely backend-agnostic (and is the riskiest part to keep correct).

---

## 2) Mandatory workspace model (determinism + no “project private deps”)

**Tsonic reference**

- Workspace is mandatory and initialized by `tsonic init`.
- Layout is deterministic: `tsonic.workspace.json`, `libs/`, `packages/<name>/tsonic.json`.

Key inspection points:

- `~/repos/tsoniclang/tsonic/packages/cli/src/commands/init.ts`
- `~/repos/tsoniclang/tsonic/docs/cli.md` (“Workspace Model (Required)”)

**Carryover to Tsuba**

- Keep a mandatory workspace in v0:
  - `tsuba.workspace.json` at root
  - `packages/*` for projects
  - a deterministic place for generated artifacts (e.g. `.tsuba/`)
- Keep workspace-scoped dependencies and lockfiles so multi-project builds are sane.

Rationale:

- This prevents the “single project → multi project” migration pain and avoids ambiguous “where did this dependency land?” issues.

---

## 3) Versioned package layout (wave regeneration)

**Tsonic reference**

Many generated repos are versioned by “platform major” under `versions/<major>/` and regenerate via scripts.

Example:

- `~/repos/tsoniclang/nodejs/package.json`:
  - `generate:10`: `./__build/scripts/generate.sh 10`
  - `publish:10`: `npm publish ./versions/10`
- `~/repos/tsoniclang/nodejs/__build/scripts/generate.sh`:
  - builds `tsbindgen`
  - generates types
  - copies README + LICENSE into `versions/<major>/`

**Carryover to Tsuba**

- All “foundation” packages should be versioned and wave-regenerable:
  - `@tsuba/core`, `@tsuba/std`, `@tsuba/gpu` (and any generated crate facades)
  - layout: `versions/<tsubaMajor>/...`
  - generator scripts: `__build/scripts/generate.sh <tsubaMajor>`
- Bindgen changes should trigger a **wave regen** of affected packages (airplane-grade).

Rationale:

- This is the only scalable way to keep emitted `.d.ts` + bindings manifests in sync with compiler changes.

---

## 4) Bindings manifest inside npm packages

**Tsonic reference**

Tsonic uses `tsonic.bindings.json` at the root of an npm package to declare native dependencies.

Key inspection points:

- `~/repos/tsoniclang/tsonic/docs/cli.md` (`tsonic add npm`)
- Example manifest: `~/repos/tsoniclang/express/versions/10/tsonic.bindings.json`

**Carryover to Tsuba**

- Use a single, mandatory manifest file shipped with bindings packages:
  - `tsuba.bindings.json`
- This file must contain (at minimum):
  - module specifier → Rust path mapping (already in spec/config.md)
  - crate identity (name/version/features)
  - optional toolchain requirements (GPU backend/capability constraints)
- CLI should support `tsuba add npm <pkg>` which:
  - installs the package
  - reads `tsuba.bindings.json`
  - merges required crate dependencies into workspace/project config

Rationale:

- This avoids “magic discovery” and makes dependency integration deterministic.

---

## 5) Core “intrinsics” pattern: `types.js` vs `lang.js`

**Tsonic reference**

Tsonic’s language surface is split:

- `@tsonic/core/types.js` — marker *types* (e.g., `int`, `ref<T>`, `out<T>`)
- `@tsonic/core/lang.js` — marker *functions* (e.g., `nameof`, `defaultof`, `asinterface`)

Key inspection points:

- `~/repos/tsoniclang/core/versions/10/types.d.ts`
- `~/repos/tsoniclang/core/versions/10/lang.d.ts`

**Carryover to Tsuba**

- Keep the same split for Tsuba:
  - `@tsuba/core/types.js` for nominal/marker types (`i32`, `u64`, `ref<T>`, etc)
  - `@tsuba/core/lang.js` for compile-time intrinsics (`unsafe`, `q`, `tokens`, `annotate`, etc)
- Do the same for GPU:
  - `@tsuba/gpu/types.js` (ptr/address-space/vector types)
  - `@tsuba/gpu/lang.js` (kernel()/launch + intrinsics)

Rationale:

- This keeps TS typechecking predictable and avoids mixing runtime helpers with compiler intrinsics.

---

## 6) Test harness: unit + golden + E2E + fixture typecheck

**Tsonic reference**

Tsonic’s test runner is a first-class product feature:

- `~/repos/tsoniclang/tsonic/test/scripts/run-all.sh`
  - unit + golden (`npm test`)
  - fixture `tsc` typecheck
  - E2E build/run fixtures with concurrency and filtering for iteration

**Carryover to Tsuba**

Adopt the same structure and discipline:

- unit tests for frontend/type system and bindgen IR
- golden tests for Rust host emission (and for PTX metadata layout)
- fixtures that must pass vanilla `tsc`
- E2E fixtures:
  - host: generate + cargo build + run
  - GPU: compile-only kernels + (optionally) run-on-GPU correctness fixtures
- a single `run-all.sh` used as the final merge gate (no filtering)

Rationale:

- GPU work is particularly prone to “compiles but wrong”; golden + reference checks are mandatory.

---

## 7) “Proof is in the pudding” repo pattern

**Tsonic reference**

- `~/repos/tsoniclang/proof-is-in-the-pudding/` contains real-ish projects and `scripts/verify-all.sh`

**Carryover to Tsuba**

Create an analogous repo early (not at the end) to keep the language honest:

- host samples (stdlib + crates)
- macro/attribute samples
- GPU samples:
  - vector add, reduction, tiled matmul, softmax
  - MoE dispatch (permute/unpermute)
  - (later) attention kernels

---

## 8) Publishing discipline (avoid main/npm drift)

**Tsonic reference**

- `~/repos/tsoniclang/tsonic/scripts/publish-npm.sh` enforces:
  - publish from `main`
  - synced with origin
  - no uncommitted changes
  - version monotonicity vs npm
  - PR-required bump branches when needed

**Carryover to Tsuba**

Port this workflow to Tsuba’s npm packages:

- `./scripts/publish-npm.sh` (same invariants)
- (later) if we publish Rust crates: `./scripts/publish-crates.sh` with similar pre-flight checks

Rationale:

- Airplane-grade requires we always know what version users will get from “latest”.

---

## 9) What we should *not* carry over

- .NET/NuGet specifics and CLR binding design (Tsuba is Rust-first).
- C#-specific features like extension-method lowering, `out/ref` C# mechanics, etc.
- Any “special casing” for specific libraries (Tsonic explicitly removed this; Tsuba should start without it).

## 10) Tsonic → Tsuba transfer matrix (roadmap-facing)

| Tsonic area | Source artifacts | Why it matters | Tsuba adoption |
|---|---|---|---|
| CLI topology | `packages/cli/src`, `packages/cli/src/commands` | Deterministic command boundaries and testable command handlers | Keep command-per-feature structure in `packages/cli/src/internal/commands` and expand tests before merging each command |
| Compiler layering | `packages/frontend/src`, `packages/emitter/src`, `packages/backend/src` | Keeps backend concerns isolated from parsing/type system/diagnostics | Keep parser/IR/typecheck in `packages/frontend`, Rust codegen in `packages/compiler`, orchestration in `packages/backend` |
| Workspace model | `packages/cli/src/commands/init.ts`, docs | Removes ambiguity in multi-project imports/output locations | Keep mandatory `tsuba.workspace.json` + per-project `tsuba.json`, deterministic generated/output paths |
| Typed manifests | `tsonic.workspace.json`, `tsonic.json`, `tsonic.bindings.json` docs | Enables reproducible dependency and output behavior | Use `tsuba.workspace.json`, `tsuba.json`, `tsuba.bindings.json` with no hidden path inference |
| Diagnostics policy | `packages/frontend/src/validator*`, `packages/frontend/src/validation*` | Airplane-grade safety requires explicit failures | Preserve explicit `TSBxxxx` diagnostics for unsupported features/unsupported emit paths |
| Test strategy | `test/scripts/run-all.sh`, `test/scripts/run-e2e.sh`, `test/scripts/typecheck-fixtures.sh` | Keeps feature growth tied to compile and fixture verification | Keep single `run-all` as merge gate; allow filtered fast iterations only |
| Publish preflight | `scripts/publish-npm.sh`, `scripts/verify-invariants.sh` | Prevents drift between repo state and published artifacts | Port equivalent preflight checks in Tsuba publish script set |
| Documentation discipline | `docs/cli.md`, architecture docs, diagnostics/reference docs | Prevents operator drift once features become complex | Add architecture-style docs for every major compiler subsystem as coverage expands |
| Reproducibility | workspace scripts + output layout checks | Enables clean bisects and stable CI behavior | Bake deterministic output layout + deterministic binding cache keys |

### Tsuba implementation order (as merged into roadmap)

1. Keep v0 behavior stable (`Phase 0` → `Phase 1`).
2. Complete `Phase 1.5` no-silent-omission gate across frontend/validator surfaces.
3. Harden `Phase 3` bindgen determinism and skip reporting before broad crate expansion.
4. Keep `run-all` full-gate required before any release/roadmap milestone.
