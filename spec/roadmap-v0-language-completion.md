# Tsuba v0 Language Completion Roadmap (Super Detailed)

This document is the **implementation-grade** roadmap for completing Tsuba’s v0 language and toolchain.

It is intentionally more detailed than `spec/roadmap.md` and is meant to be used as the single checklist for
the next “big PR” on branch `feat/v0-language-completion`.

Principles:

- **Airplane-grade**: never silently miscompile; never silently omit meaningfully-used constructs.
- **TS-valid**: all user source must typecheck in `tsc` without custom TS transforms.
- **Rust-first**: when TS and Rust semantics conflict, Tsuba follows Rust and may reject TS.
- **GPU-first**: kernels are first-class and not “later”.

---

## 0. What “v0 complete” means

“v0 complete” does not mean “supports all of TypeScript”.

It means:

1. The language subset is **explicit**, **test-covered**, and **stable**.
2. Core programs in the target domain (systems TS + GPU kernels) compile deterministically.
3. Missing features fail loudly with stable error codes (`TSBxxxx`), with a clear migration path.

This roadmap is organized as **workstreams** with **merge gates**.

---

## 1. Merge gates and developer workflow

### 1.1 Mandatory PR workflow

Branch protection is enabled. All work goes through PRs (no direct `main` pushes).

This is enforced socially and documented in `AGENTS.md`.

### 1.2 Test gates

Fast iteration (allowed during development):

- `npm run test:cli -- --grep <pattern>`
- `npm run test:compiler -- --grep <pattern>`

Final verification (required before merge/publish):

- `npm run run-all`

Additional gate we should adopt (Tsonic-style):

- “dirty-tree after tests” is a failure. Tests must not leave generated files behind.

### 1.3 Determinism gates

For all “golden-ish” outputs (generated Rust, CUDA, manifests):

- same input + config → bitwise-identical output, including ordering and formatting
- no environment-dependent paths embedded (except in explicit debug logs)

---

## 2. Current state snapshot (as of 2026-02-19)

This snapshot is intentionally implementation-facing.

Implemented today:

- Mandatory workspace/project config model is active (`tsuba.workspace.json`, `tsuba.json`).
- Host compiler supports:
  - generic functions/classes/interfaces,
  - interface methods → trait items,
  - `implements` checking with signature/receiver validation,
  - async/await lowering with runtime policy (`none` vs `tokio`),
  - stable `TSBxxxx` diagnostics for unsupported/rejected constructs.
- GPU path is active:
  - kernel DSL markers,
  - deterministic CUDA C emission + PTX compilation path,
  - host launch/runtime glue.
- CLI no longer depends on an external bindgen binary; it invokes `@tsuba/tsubabindgen` as a library.
- Bindgen tests avoid fixture dirtiness by generating from copied temp crates.

Still incomplete for parity-grade v0:

- Compiler architecture is still too concentrated in `packages/compiler/src/rust/host.ts` (needs cleaner pass boundaries).
- `tsubabindgen` is still MVP-grade and source/regex-heavy (needs robust extraction path and broader coverage).
- Release/publish preflight scripts are missing.
- External proof-repo verification is not yet wired into the release gate.

For the explicit parity matrix vs Tsonic, see:

- `spec/roadmap-parity-with-tsonic.md`

---

## 3. Workstream A: Toolchain hygiene and packaging invariants

Status (current): **Mostly done**, with release preflight still missing.

These items are “small” but unblock the entire repo from being reliable at scale.

### A1. CLI must be able to run bindgen in a standalone install

Current state:

- **Completed** via direct library invocation.
- `@tsuba/cli` imports `runGenerate` from `@tsuba/tsubabindgen` in command handlers.

Policy:

- Keep this as the only supported path (no external PATH binary dependency).

Merge gate:

- A “packed CLI smoke test” (install tarballs into a fresh temp dir) succeeds for:
  - `tsuba bindgen ...`
  - `tsuba add crate ...`
  - `tsuba add path ...`

### A2. Tests must not dirty the repo

Current state:

- **Completed** in bindgen tests by copying fixture crates to temp directories before metadata extraction.

Policy:

- Preserve fixture immutability as a hard requirement for all future bindgen tests.

Merge gate:

- `npm run run-all` leaves `git status --porcelain` empty.

### A3. Publish preflight discipline (later, but plan it now)

Current state:

- **Partially completed**: npm preflight and publish flow is implemented in `scripts/publish-npm.sh`.
- Enforced checks include:
  - branch must be `main`
  - working tree must be clean
  - local `main` must match `origin/main`
  - full `npm run run-all` gate (unless explicitly skipped)
  - package version must not already exist on npm

Remaining scope:

- add crates publish preflight with equivalent invariants
- add release-note/tag workflow integration

Merge gate:

- `scripts/publish-*.sh` exists for npm and crates with parity preflight checks.

---

## 4. Workstream B: Compiler foundations (airplane-grade IR and diagnostics)

Status (current): **Partial**.

Goal: make it safe to extend the compiler without accidental miscompiles.

### B1. Enforce “no silent omission”

Rule:

- every unsupported syntactic construct that is *reachable* in accepted TS must error with stable `TSBxxxx`.

Current state:

- Compiler diagnostic codes are now centralized and validated through `packages/compiler/src/rust/diagnostics.ts`.
- `CompileError`/`fail`/`failAt` enforce code registration.
- A synchronization test ensures every `TSBxxxx` used in `host.ts` is registered.

Implementation approach:

- Add a per-node lowering “default case” that throws `TSB11xx` with node kind name.
- Add tests that assert representative unsupported constructs hard-error.

### B2. Typed IR coverage

The current emitter already has a Rust IR (`packages/compiler/src/rust/ir.ts`) and writer.

We should keep expanding coverage to ensure emission is always:

- IR construction (typechecked / validated)
- deterministic writer

No ad-hoc string concatenation outside the writer.

### B3. Spans: end-to-end source mapping

Requirements:

- Every emitted item/stmt/expr carries an optional `Span`.
- Errors surface:
  - `TSBxxxx`
  - TS location (file/line/col)
  - and when applicable the mapped rustc error location.

Merge gate:

- A “diagnostics fixture suite” that asserts codes and stable messages for:
  - missing types
  - unsupported constructs
  - trait mismatch
  - async/await misuse
  - kernel misuse

---

## 5. Workstream C: Type system and “systems TS” surface completion

Status (current): **Partial** (generic core is implemented; edge-case matrix still expanding).

### C1. Numeric and literal rules

Continue the policy used in kernel code:

- numeric literals must be explicit casts where type matters (`1 as u32`, `0.0 as f32`)
- avoid implicit widening that could miscompile

Host code may be a bit more permissive than kernels, but must remain deterministic.

### C2. Optional/undefined/null policy

Keep v0 strictness:

- no optional parameters (`x?: T`) in Tsuba source; use `Option<T>`
- no `undefined`; use `Option` or unit `()`
- no `null`

These are already partially enforced; expand tests to cover all entrypoints.

### C3. Generics (required for real traits)

This is a major feature. “Full traits” requires generics.

Required scopes:

- generic functions: `function f<T>(x: T): T`
- generic methods
- generic classes (structs)
- generic interfaces (traits)
- generic type aliases (for “associated types as generics” patterns)

Constraints for v0:

- no conditional types
- no mapped types
- no inference that depends on TS-only type-level computation

Merge gates:

- Golden tests for:
  - generic identity
  - generic struct + impl
  - generic trait bounds
  - generic trait method calls

---

## 6. Workstream D: Full trait support (interfaces → Rust traits)

Status (current): **Core done** for v0 host subset; trait-object strategy remains optional.

This is the highest-leverage “language completion” feature.

### D0. Design constraints

- TS surface must remain idiomatic and typecheck in `tsc`.
- Rust emission must be faithful and deterministic.
- Avoid “TS structural typing” leaks: trait conformance must be explicit (`implements`).

### D1. Interface members (trait items)

Current support baseline:

- method signatures on interfaces (no bodies)
- receiver modeled explicitly

Receiver modeling (proposed):

- require an explicit first parameter: `this: ref<this>` or `this: mutref<this>`

Examples:

```ts
import type { ref, mutref, i32 } from "@tsuba/core/types.js";

export interface Quackable {
  quack(this: ref<this>): void;
}

export interface CounterLike {
  inc(this: mutref<this>): void;
  get(this: ref<this>): i32;
}
```

Rust:

```rs
pub trait Quackable { fn quack(&self); }
pub trait CounterLike { fn inc(&mut self); fn get(&self) -> i32; }
```

Merge gate:

- trait items emitted deterministically
- call sites resolve correctly when bounds are present

### D2. Implementations: `implements`

Current support baseline:

- `class X implements Trait { ... }` → `impl Trait for X {}`
- multiple implements: `implements A, B`
- generic implements: `implements Iterator<i32>`

Airplane-grade checks:

- class must implement all required methods with signature compatibility:
  - same method name
  - same arity
  - receiver mutability matches (`&self` vs `&mut self`)
  - parameter/return types match exactly under Rust type equality rules (including marker-lowered types)

No “best effort”: mismatch must be a compile error with a stable code.

### D3. Trait bounds from TS generics

Current support baseline:

- `T extends Trait` → `T: Trait`
- `T extends A & B` → `T: A + B`
- `function f<T extends Trait>(x: T): void { x.m(); }`

### D4. Supertraits: interface extends interface

Current support baseline:

```ts
export interface Readable { read(this: ref<this>): i32; }
export interface Writable extends Readable { write(this: mutref<this>, x: i32): void; }
```

Rust:

```rs
pub trait Readable { fn read(&self) -> i32; }
pub trait Writable: Readable { fn write(&mut self, x: i32); }
```

### D5. “Associated types” strategy (for bindgen and real Rust interop)

Rust traits commonly use associated types. TS has no native syntax for them.

v0 strategy:

- bindgen converts each associated type into a generic parameter on the trait.

Example Rust:

```rs
trait Iterator { type Item; fn next(&mut self) -> Option<Self::Item>; }
```

Generated TS:

```ts
export interface Iterator<Item> {
  next(this: mutref<this>): Option<Item>;
}
```

Then bounds are written as `T extends Iterator<i32>`.

### D6. Trait objects / existentials (optional in v0, but plan it)

Mojo has `Some[Trait]`. If we adopt this idea, it must remain TS-valid and Rust-faithful.

Proposed TS markers (pick one):

- `Dyn<Trait>` marker type: `type Dyn<T> = T;` lowered to `Box<dyn Trait>`
- `Some<Trait>` alias for `Dyn<Trait>` to match Mojo terminology

Constraints:

- object safety rules are Rust’s; if a trait is not object-safe, error.
- require explicit heap boxing in TS surface (marker constructor), to avoid hidden allocations.

Merge gate:

- one proof fixture uses trait objects without hacks.

---

## 7. Workstream E: Async/await (Rust futures + runtime)

Status (current): **Core done** (`Promise<T>` surface + `tokio` runtime policy).

Baseline is implemented; remaining work is breadth/coverage hardening.

### E1. Define the TS surface for futures

Mojo uses `fn ... raises` etc. Tsuba should stay Rust-like:

- Use `Promise<T>` in TS as the surface type (because it exists in standard TS libs).
- Lower to Rust `async fn ... -> T` (future semantics through Rust async lowering).

We must avoid emitting a Rust type named `Promise`.

### E2. Implement `async function` lowering

Current support baseline:

- `async function f(): Promise<T>` → `async fn f() -> T` (or `-> Result<...>` if wrapped)
- Inside, `await expr` lowers to `expr.await`

Airplane-grade constraints:

- `.then(...)` is rejected in Tsuba source.
- `await` is only valid inside `async` functions.

### E3. Runtime selection

Current support baseline (`runtime.kind`):

- `runtime.kind: "none"`: allow async functions but disallow `export async function main` (or require explicit executor call).
- `runtime.kind: "tokio"`:
  - `export async function main(): Promise<void>` lowers to `#[tokio::main] async fn main()`

This likely requires:

- adding a small `@tsuba/std/runtime` facade OR generating the minimal runtime glue in the generated crate.
- a consistent policy for adding the required crate dependency (`tokio`) via config.

Merge gate:

- proof fixture: async main + await compiles and runs with `tokio`.

---

## 8. Workstream F: Compile-time parameterization (Mojo idea, TS-valid)

Status (current): **Partial**.

Mojo’s `[...]` compile-time params and `@parameter` loops are *semantics*, not syntax.

Tsuba must implement the same power via TS-valid constructs:

### F1. Kernel specialization (already planned)

- Extend kernel spec to include `specialize` constants.
- Allow kernel code to reference spec constants and treat them as compile-time constants.

Example:

```ts
const spec = { name: "reduce", specialize: { VEC: 4 as const } } as const;
export const k = kernel(spec, (...) => {
  const vec = spec.specialize.VEC;
  // vec is compile-time constant
});
```

Implementation constraints:

- spec object must remain an `as const` literal
- references to spec must be provably the same symbol (no dynamic aliasing)

### F2. Compile-time loop unrolling (kernel-only, v0)

Avoid new syntax.

Use a marker intrinsic instead:

- `unroll(() => { for (...) { ... } })`
- or `unrollFor<N>(...)` style helper

Lowering:

- emit `#pragma unroll` or direct unrolled statements when bounds are small and constant.

Merge gate:

- golden tests that confirm:
  - constant propagation works
  - invalid “not-constant” usage errors

---

## 9. Workstream G: Bindgen hardening (`tsubabindgen`)

Status (current): **Partial** (determinism basics are in place; extractor depth is not yet airplane-grade).

Current state:

- Trait facades are now emitted (`pub trait` → TS `interface`).
- Associated types are represented as extra trait generic parameters.
- Skip reporting is deterministic (`tsubabindgen.report.json` with stable ordering + explicit reasons).

The MVP exists; it must become deterministic and scalable.

### G1. Source of truth

Pick a deterministic extractor:

1. `rustdoc-json` (nightly) may be acceptable in v0 if we version-pin toolchain
2. a small Rust helper using `syn` + `cargo metadata` (preferred long-term for determinism and stability)

Document the choice and enforce it in tests.

### G2. Surface coverage (minimum)

Bindgen must cover:

- structs/enums
- impl methods (including `&self`, `&mut self`, constructors)
- traits (including associated types converted to generics)
- functions
- references (`&T`, `&mut T`, lifetimes)
- macros (per `spec/macros.md`) via marker values

### G3. Skip reporting

If bindgen cannot represent something safely:

- it must include an entry in `tsubabindgen.report.json`
- and must never silently omit public surface that was referenced by exported items

### G4. Determinism tests

Add tests that:

- run bindgen twice and compare output byte-for-byte
- ensure no fixture dirtiness
- ensure output order is stable

---

## 10. Workstream H: Standard library facades

Status (current): **Partial**.

Tsuba does not need to “re-document Rust”, but it needs enough facades to make code ergonomic.

Minimum for v0:

- `Option`, `Result`, constructors, `q`
- `Vec`, `HashMap` with ownership-aware methods
- string formatting macro(s) (`println`)

Later:

- iterators
- slices and string views (`&str`)
- error trait facade strategy

---

## 11. Workstream I: GPU completion (toward SOTA kernels)

Status (current): **Partial** (credibility kernels exist; SOTA-ready intrinsics/capability coverage is not complete).

The current kernel dialect is credibility-level; we need a path to SOTA.

### I1. Kernel dialect spec completeness

Make `spec/gpu.md` exhaustive:

- allowed expressions/statements
- type rules
- memory address spaces
- capability gating rules

### I2. Tensor/view model

Define and implement:

- dtype/layout/device/strides
- views (no copies unless explicit)

### I3. Performance intrinsics

Add markers (kernel-only):

- vectorized load/store
- warp-level ops
- atomics set
- fast-math toggles

### I4. Correctness suite

Add reference kernels and CPU validation:

- vector add
- reduction
- matmul block
- softmax
- MoE permute/unpermute building blocks

Merge gate:

- if CUDA available, run correctness checks
- otherwise compile-only deterministic PTX checks

---

## 12. Mojo construct mapping (summary)

Mojo constructs we effectively already align with:

- `read/mut/out` intent maps to `ref/mutref/mut` markers.
- compile-time specialization goal maps to kernel spec + specialization.
- trait-centric design maps to interface → trait (this roadmap).

Mojo constructs we should not adopt (not TS-valid or not Rust-first):

- `def` vs `fn` keywords
- `raises` / exception-style error model (Tsuba uses `Result`)
- `with` as a new syntax form (use TS-valid RAII patterns later)

---

## 13. Definition of Done checklist

v0 is “done” when:

- Traits:
  - interfaces with method members compile to real Rust traits
  - generic traits + bounds work
  - classes implementing traits are checked and emit correct `impl`
- Async:
  - async functions and `await` lower correctly
  - tokio runtime option works for async main
- Bindgen:
  - deterministic output + skip reporting
  - trait surfaces can be generated
- Tooling:
  - CLI can run bindgen standalone
  - tests do not dirty the repo
- GPU:
  - kernel dialect is explicitly spec’d
  - PTX pipeline is deterministic
  - at least the credibility kernels compile deterministically
