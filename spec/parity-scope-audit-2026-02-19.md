# Tsuba vs Tsonic Scope Audit (2026-02-19)

This is a structural parity audit to guide the next mega PR waves.

## 1) Snapshot baseline

`tsuba` (this repo) vs `tsonic`:

- Tracked files: `221 / 1419` (**15.6%**)
- Compiler source files:
  - Tsuba `packages/compiler/src`: `23`
  - Tsonic `packages/frontend/src + packages/emitter/src`: `336`
  - Ratio: `23 / 336` (**6.8%**)
- Compiler TypeScript LOC:
  - Tsuba compiler: `10069`
  - Tsonic frontend+emitter: `84772`
  - Ratio: `10069 / 84772` (**11.9%**)
- Compiler test case count (`it(...)`):
  - Tsuba: `111`
  - Tsonic frontend+emitter: `699`
  - Ratio: `111 / 699` (**15.9%**)
- Fixture directory count:
  - Tsuba `test/fixtures`: `12`
  - Tsonic `test/fixtures`: `142`
  - Ratio: `12 / 142` (**8.5%**)

Interpretation:

- Architecture discipline is now converging.
- Surface-area and fixture breadth are still the dominant parity gap.

## 2) Architecture comparison

Tsonic has broad decomposition:

- frontend graph/extraction, resolver, symbol-table
- IR builder/converters/validation/type-system
- emitter expressions/statements/types/specialization/invariants

Tsuba now has foundational pass separation in compiler:

- `passes/bootstrap.ts`
- `passes/module-index.ts`
- `passes/file-lowering.ts`
- `passes/type-models.ts`
- `passes/annotations.ts`
- `passes/declaration-emission.ts`
- `passes/main-emission.ts`

Remaining architecture gap:

- statement/expression lowering is still concentrated in `rust/host.ts`.
- dedicated validation passes are still mostly embedded in lowering path.

## 3) Roadmap status percentages

From `spec/roadmap-tsonic-grade-parity.md`:

- Workstreams A–K completion: **84.1%** (`90/107`)
- P0/P1 workstreams completion: **83.7%** (`87/104`)
- Including exit criteria checklist lines: **80.4%** (`90/112`)

Workstreams fully complete:

- D, E, F, G, J, K = **6 / 11**

Largest open gaps:

1. **H (external proof and scale)** — 20.0%
2. **A/B/C closures** — pass isolation completeness + semantic matrix closure + diagnostic normalization
3. **I signed tags** — process/publishing policy completion

## 4) Current mega-wave priorities

Priority order for upcoming mega PRs:

1. **Compiler decomposition wave**
   - move remaining statement/expression lowering into dedicated pass modules
   - reduce `rust/host.ts` to orchestration only
2. **Semantic coverage wave**
   - close all open B-matrix items with explicit tests + evidence links
3. **Diagnostic normalization wave**
   - enforce message-family consistency for same root causes
   - keep span/actionability guarantees universal
4. **External proof wave**
   - expand proof projects and attach release-blocking verification evidence

## 5) Confidence statement

Tsuba is now in a strong parity trajectory with airplane-grade discipline in place, but it is still materially smaller than Tsonic in both source and fixture breadth. Closing parity now is primarily a scale/coverage task, not a direction task.
