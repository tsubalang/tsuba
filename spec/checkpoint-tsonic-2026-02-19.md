# Tsonic checkpoint (2026-02-19): architecture and portability scan

This checkpoint is used to prevent drift while building Tsuba.  
It captures the most transferable ideas from Tsonic’s current v0 implementation
and calls out what is relevant/adapted for Rust/GPU semantics.

## What was inspected in Tsonic

Scanned source and process across:

- `packages/cli/src` (38 files)
- `packages/frontend/src` (182 files)
- `packages/emitter/src` (154 files)
- `packages/backend/src` (9 files)
- `npm/tsonic/*`
- `test/scripts/{run-all.sh,run-e2e.sh,typecheck-fixtures.sh}`
- `scripts/publish-npm.sh`
- `scripts/verify-invariants.sh` + publish scripts
- architecture docs in `docs/architecture/*` and core docs (`docs/cli.md`,
  `docs/limitations.md`, `docs/type-system.md`, `docs/build-output.md`)

Not carried into this checkpoint: non-source artifacts such as
`packages/*/dist`, generated fixture outputs, and compiled artifacts under
`test/fixtures/*/generated/bin` (they are useful for debugging, but not for
design-level carryover).

## High-value transfer patterns for Tsuba

### 1) Compiler pipeline layout

- Tsonic is a strict, layered compiler:
  `parse → resolve → validate → IR build → dependency analysis → emit → backend`.
- Tsuba should keep the same layer naming and module boundaries.
  - This is less about one-to-one code transfer and more about forcing explicit
    handoff contracts between phases.

### 2) CLI command architecture

Tsonic separates command parsing/dispatch, command implementations, and command
tests with a predictable “command module + public API + CLI parser” model.

- Transfer:
  - `init` as deterministic workspace bootstrap.
  - `build`, `run`, `test` flow as first-class commands.
  - `add`/`restore`-style flows as package-manifest extension points.
  - Explicit config helpers (`workspace` + per-project config I/O) split from command logic.
- Adapt for Tsuba:
  - no .NET-specific dependency modes.
  - add explicit Rust dependency model (`deps.crates` + manifest import hooks).
  - replace `add package/framework` behavior with rust crate path/version flow.

### 3) Typed configuration + deterministic manifests

Tsonic’s `tsonic.workspace.json`, `tsonaic.json`, and `tsonic.bindings.json` model
provides a strong example of deterministic build inputs.

- Transfer:
  - Keep dedicated JSON schemas at workspace + project level.
  - Keep package-local vs workspace-local dependency ownership explicit.
  - Keep a manifest carried in package metadata (`tsuba.bindings.json`) for import→crate mapping.
- Keep the same discipline in Tsuba:
  - `tsuba.workspace.json`, `tsuba.json`, `tsuba.bindings.json`
  - no hidden inference of package identity from import path shape.

### 4) Error model and validation gate

Tsonic’s `validator` layer is explicit and test-driven. It fails with stable
diagnostic IDs and avoids silent fallback behavior.

- Transfer:
  - centralize validation in one phase before IR build.
  - enforce “no silent omission” as default; emit explicit diagnostic codes.
  - separate parse-time vs semantic-phase diagnostics.
- Adopt for Tsuba:
  - `TSBxxxx` policy remains (as started in v0).
  - all unsupported constructs should emit errors, never approximate semantics.

### 5) Golden + fixture test philosophy

Tsonic’s `test/scripts/run-all.sh` is effectively a compile matrix:
unit + golden + typecheck + parallel E2E + summary output.

- Transfer:
  - maintain one canonical `run-all.sh`.
  - keep filter/no-unit modes for iteration, but enforce full run before merge.
  - keep fixture-driven E2E as regression boundary, including generated Rust/C++/PTX expectations.
- Expand for Tsuba:
  - include host and GPU compile/compare modes in the same script.
  - retain final-no-filter gate requirement.

### 6) Workspace-centric dependency model

Tsonic’s workspace-first approach minimizes ambiguous per-project behavior.

- Transfer:
  - deterministic workspace root discovery (`find` upwards).
  - generated outputs in fixed workspace-relative locations.
  - clear package boundaries for import and build artifacts.
- Keep in Tsuba:
  - `tsuba.workspace.json` + `packages/<name>/tsuba.json`.
  - generated sources and outputs under configured workspace directories.

### 7) Release discipline

Tsonic has pre-flight checks for publish gates (branch, sync status, version monotonicity, consistency).

- Transfer:
  - keep strict pre-publish checks even when project footprint is still small.
  - avoid publishing from diverged/non-branch-clean states.
- For Tsuba:
  - add/retain equivalent checks in `scripts/publish-npm.sh` and eventually crates release step.

## What to intentionally keep different in Tsuba

- No `.NET` namespace semantics.
- No extension-method lowering model from C#.
- No promise-chain semantics (`then`) and no JS-style callback coercions.
- Rust borrow/lifetime behavior is a compile-time contract (prefer hard errors from rustc).
- GPU backend and kernel surface are not present in Tsonic; they stay unique to Tsuba.

## Immediate plan merge into roadmap

Use this checkpoint in Phase 0/1 before new feature expansion:

- **Phase 0.5**: establish tsonic-style monorepo gates and scripts.
- **Phase 1**: make compiler phases explicit and testable in the same split as Tsonic.
- **Phase 1.5**: enforce no-silent-omission diagnostics for every unsupported syntax pattern.
- **Phase 8**: publishing script parity (pre-flight checks first, release branch on bump).

This file should be treated as the canonical “do-not-drift” reference until
`v0.1` of the Tsuba roadmap is reached.

