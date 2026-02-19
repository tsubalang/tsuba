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

- `npm test`

Additional gate we should adopt (Tsonic-style):

- “dirty-tree after tests” is a failure. Tests must not leave generated files behind.

### 1.3 Determinism gates

For all “golden-ish” outputs (generated Rust, CUDA, manifests):

- same input + config → bitwise-identical output, including ordering and formatting
- no environment-dependent paths embedded (except in explicit debug logs)

---

## 2. Current state snapshot (as of 2026-02-19)

This is a quick reality check so the roadmap stays grounded:

- Workspace + project configs exist: `tsuba.workspace.json`, `tsuba.json`.
- Host compiler exists: `@tsuba/compiler` emits a restricted TS subset to Rust.
- GPU kernel pipeline exists (v0 credibility): emits deterministic CUDA C, compiles PTX via configured toolkit, launches via CUDA driver runtime.
- Marker APIs exist:
  - `@tsuba/core/types.js`: numeric markers, `ref/mutref`, `Option/Result`, etc.
  - `@tsuba/core/lang.js`: `q`, `unsafe`, `tokens/attr/annotate`.
- `tsubabindgen` exists but is MVP and currently source/regex-based.

Known gaps that must be fixed early (because they affect everything else):

- **Traits are not implemented** (interfaces are marker traits only; no members; no generic traits).
- **Async/await is not implemented** in the compiler even though the spec describes it.
- CLI assumes an external `tsubabindgen` binary is available, but `@tsuba/cli` does not depend on `@tsuba/tsubabindgen`.
- Some tests cause repository dirtiness (`Cargo.lock` creation under fixtures).

---

## 3. Workstream A: Toolchain hygiene and packaging invariants

These items are “small” but unblock the entire repo from being reliable at scale.

### A1. CLI must be able to run bindgen in a standalone install

Problem:

- `@tsuba/cli` runs `tsubabindgen` via `spawnSync("tsubabindgen", ...)`.
- `@tsuba/cli` does not depend on `@tsuba/tsubabindgen`.

Acceptable airplane-grade fixes (pick one; prefer the most deterministic):

1. **Library call**: `@tsuba/cli` imports `runGenerate` from `@tsuba/tsubabindgen` and calls it directly.
2. **Resolved binary path**: locate `@tsuba/tsubabindgen` package root and run its `dist/bin.js` via `node`.
3. **Dependency + PATH expectation**: add `@tsuba/tsubabindgen` as a dependency and assume npm will place it in `.bin`.
   This is acceptable but more fragile across install modes than (1) or (2).

Merge gate:

- A “packed CLI smoke test” (install tarballs into a fresh temp dir) succeeds for:
  - `tsuba bindgen ...`
  - `tsuba add crate ...`
  - `tsuba add path ...`

### A2. Tests must not dirty the repo

Problem:

- `tsubabindgen` tests run `cargo metadata` in fixture crate directory and create `Cargo.lock`.

Fix:

- Copy the fixture crate into a temp directory before running cargo commands, or force a `CARGO_TARGET_DIR`
  and ensure lock file is not created in the fixture directory.

Merge gate:

- `npm test` leaves `git status --porcelain` empty.

### A3. Publish preflight discipline (later, but plan it now)

We should port Tsonic-style publish invariants:

- only publish from `main` (or a tagged release branch)
- working tree clean
- remote synced
- version bump present

Merge gate:

- A single `scripts/publish-*.sh` exists for npm packages (and later for crates) with invariant checks.

---

## 4. Workstream B: Compiler foundations (airplane-grade IR and diagnostics)

Goal: make it safe to extend the compiler without accidental miscompiles.

### B1. Enforce “no silent omission”

Rule:

- every unsupported syntactic construct that is *reachable* in accepted TS must error with stable `TSBxxxx`.

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

This is the highest-leverage “language completion” feature.

### D0. Design constraints

- TS surface must remain idiomatic and typecheck in `tsc`.
- Rust emission must be faithful and deterministic.
- Avoid “TS structural typing” leaks: trait conformance must be explicit (`implements`).

### D1. Interface members (trait items)

Support at least:

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

Support:

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

Support:

- `T extends Trait` → `T: Trait`
- `T extends A & B` → `T: A + B`
- `function f<T extends Trait>(x: T): void { x.m(); }`

### D4. Supertraits: interface extends interface

Support:

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

This must be implemented because it is required for real apps and discussed heavily.

### E1. Define the TS surface for futures

Mojo uses `fn ... raises` etc. Tsuba should stay Rust-like:

- Use `Promise<T>` in TS as the surface type (because it exists in standard TS libs).
- Lower to Rust `impl Future<Output = T>` in function signatures.

We must avoid emitting a Rust type named `Promise`.

### E2. Implement `async function` lowering

Required:

- `async function f(): Promise<T>` → `async fn f() -> T` (or `-> Result<...>` if wrapped)
- Inside, `await expr` lowers to `expr.await`

Airplane-grade constraints:

- `.then(...)` is rejected in Tsuba source.
- `await` is only valid inside `async` functions.

### E3. Runtime selection

We already have `runtime.kind` in workspace config. Implement:

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

