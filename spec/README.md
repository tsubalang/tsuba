# Tsuba Specs

This directory contains the language + toolchain specifications for **Tsuba** — a Rust-first language that uses **TypeScript** as its surface syntax.

Principles:

- Tsuba code must be valid TypeScript that typechecks in `tsc`.
- Tsuba rejects many valid TS/JS patterns that cannot be mapped to Rust in an airplane-grade way.
- Tsuba may rely on `rustc` for ownership/borrow/lifetime errors.
- Tsuba must never silently miscompile or insert hidden clones/boxes/conversions.

## Active specs (source of truth)

- `tsuba-v0.md` — high-level v0 overview + scope checklist.
- `language.md` — Tsuba TS subset + Rust lowering rules.
- `feature-matrix.md` — executable support matrix with test evidence.
- `omissions-v0.md` — explicit TS surface omissions for v0.
- `markers.md` — marker APIs in `@tsuba/core/types.js` + `@tsuba/core/lang.js`.
- `gpu.md` — GPU-first kernel dialect + CUDA/PTX direction.
- `macros.md` — macro + attribute model (no blessed macro list).
- `stdlib.md` — `@tsuba/std` facade expectations.
- `examples.md` — side-by-side Python/Rust/Tsuba examples.
- `moe.md` — MoE-focused kernel/host direction notes.
- `config.md` — `tsuba.workspace.json`, `tsuba.json`, `tsuba.bindings.json`.
- `tsubabindgen.md` — bindgen design and v0 constraints.
- `tsubabindgen-representability.md` — bindgen skip taxonomy + determinism contract.
- `compiler-pass-contracts.md` — compiler pass graph and pass I/O contracts.
- `diagnostics-catalog.md` — high-frequency `TSBxxxx` catalog by domain.
- `roadmap.md` — phased build plan and merge gates.
- `roadmap-v0-language-completion.md` — detailed v0 completion checklist.
- `roadmap-parity-with-tsonic.md` — parity matrix and transfer work.
- `roadmap-tsonic-grade-parity.md` — maturity parity checklist.
- `release-playbook.md` — preflight, publish order, rollback/republish policy.
- `incremental-build-roadmap.md` — deterministic incremental build strategy.
- `external-proof-matrix.json` — required external proof categories/targets.
- `diagnostic-quality-baseline.json` — minimum diagnostic quality thresholds.
- `perf-budgets.json` — required E2E runtime/memory budgets.

## Historical audits/checkpoints (archive)

- `archive/tsonic-checkpoints/carryover-from-tsonic.md`
- `archive/tsonic-checkpoints/checkpoint-tsonic-2026-02-19.md`
- `archive/parity-audits/parity-scope-audit-2026-02-19.md`
- `archive/parity-audits/tsonic-tsbindgen-feature-coverage-audit-2026-02-19.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-19-wave15.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-19-wave17.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-19-wave18.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-19-wave19.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-20-wave20.md`
- `archive/architecture-cleanliness/architecture-cleanliness-audit-2026-02-20-wave21.md`
