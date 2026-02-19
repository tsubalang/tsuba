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
- `feature-matrix.md` — executable support matrix (supported/rejected/planned) with test evidence.
- `omissions-v0.md` — explicit TS surface omissions for v0 (must stay synced with diagnostics/tests).
- `markers.md` — marker APIs in `@tsuba/core/types.js` + `@tsuba/core/lang.js`.
- `gpu.md` — GPU-first kernel dialect + CUDA/PTX direction.
- `examples.md` — side-by-side Python/Rust/Tsuba examples (host + kernels).
- `macros.md` — macro + attribute model (no blessed macro list).
- `carryover-from-tsonic.md` — what we reuse from the Tsonic ecosystem.
- `roadmap.md` — phased build plan and merge gates.
- `roadmap-parity-with-tsonic.md` — parity matrix and remaining transfer work from Tsonic quality gates.
- `checkpoint-tsonic-2026-02-19.md` — transfer matrix from Tsonic (no-drift checkpoint).
- `parity-scope-audit-2026-02-19.md` — structural scope audit vs Tsonic (files/LOC/tests/fixtures and gap priorities).
- `architecture-cleanliness-audit-2026-02-19-wave17.md` — latest architecture cleanliness + operational hardening audit.
- `architecture-cleanliness-audit-2026-02-19-wave18.md` — wave18 architecture cleanup + substantial proof-matrix hardening audit.
- `architecture-cleanliness-audit-2026-02-19-wave19.md` — wave19 architecture decomposition audit (kernel dialect extraction + bindgen staged pipeline).
- `architecture-cleanliness-audit-2026-02-20-wave20.md` — wave20 architecture audit (HIR boundary + MIR body pass + source-map/cache isolation).
- `architecture-cleanliness-audit-2026-02-20-wave21.md` — wave21 architecture audit (host/bindgen hotspot decomposition plan + parity scale-up gates).
- `tsonic-tsbindgen-feature-coverage-audit-2026-02-19.md` — doc-driven feature/omission audit against Tsonic + tsbindgen surfaces.
- `stdlib.md` — proposed `@tsuba/std` facades (plus tokio/serde/web expectations).
- `config.md` — `tsuba.workspace.json`, `tsuba.json`, and `tsuba.bindings.json`.
- `tsubabindgen.md` — bindgen design and v0 constraints.
- `tsubabindgen-representability.md` — concrete bindgen surface/skip taxonomy and determinism contract.
- `compiler-pass-contracts.md` — compiler pass graph and pass I/O contract.
- `diagnostics-catalog.md` — high-frequency `TSBxxxx` diagnostic catalog by domain.
- `external-proof-matrix.json` — required external proof categories/targets (host-service, GPU-heavy, bindgen-heavy).
- `diagnostic-quality-baseline.json` — minimum diagnostic quality thresholds used by release/run-all checks.
- `release-playbook.md` — release preflight, publish order, rollback/republish policy.
- `incremental-build-roadmap.md` — phased deterministic incremental build strategy with fail-safe fallback.
