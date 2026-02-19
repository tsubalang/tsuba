# Tsuba Specs

This directory contains the language + toolchain specifications for **Tsuba** — a Rust-first language that uses **TypeScript** as its surface syntax.

Principles:

- Tsuba code must be valid TypeScript that typechecks in `tsc`.
- Tsuba rejects many valid TS/JS patterns that cannot be mapped to Rust in an airplane-grade way.
- Tsuba may rely on `rustc` for ownership/borrow/lifetime errors.
- Tsuba must never silently miscompile or insert hidden clones/boxes/conversions.

Specs:

- `tsuba-v0.md` — high-level v0 overview + scope checklist.
- `language.md` — the Tsuba TS subset + Rust lowering rules.
- `markers.md` — marker APIs in `@tsuba/core/types.js` + `@tsuba/core/lang.js`.
- `gpu.md` — GPU-first kernel dialect + CUDA/PTX direction.
- `examples.md` — side-by-side Python/Rust/Tsuba examples (host + kernels).
- `macros.md` — macro + attribute model (no blessed macro list).
- `carryover-from-tsonic.md` — what we reuse from the Tsonic ecosystem.
- `roadmap.md` — phased build plan and merge gates.
- `roadmap-parity-with-tsonic.md` — parity matrix and remaining transfer work from Tsonic quality gates.
- `checkpoint-tsonic-2026-02-19.md` — transfer matrix from Tsonic (no-drift checkpoint).
- `stdlib.md` — proposed `@tsuba/std` facades (plus tokio/serde/web expectations).
- `config.md` — `tsuba.workspace.json`, `tsuba.json`, and `tsuba.bindings.json`.
- `tsubabindgen.md` — bindgen design and v0 constraints.
