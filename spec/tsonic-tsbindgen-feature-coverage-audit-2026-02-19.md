# Tsonic / tsbindgen Feature Coverage Audit vs Tsuba (2026-02-19)

This is a documentation-driven gap audit against:

- `tsonic` docs (`README.md` + `docs/*.md`)
- `tsbindgen` docs (`README.md` + `docs/**/*.md`)

Goal:

- identify which documented surfaces are already covered in Tsuba,
- isolate what is still missing,
- distinguish intentional omissions from undocumented gaps.

---

## 1) Tsonic language/doc surface vs Tsuba

Status legend:

- **Covered**: implemented + test/spec evidence exists.
- **Partial**: implemented subset or behavior is incomplete.
- **Missing (documented)**: intentionally omitted and documented in Tsuba specs.
- **Missing (undocumented)**: currently absent without clear omission callout in core user-facing language docs.

| Area | Tsonic documented surface | Tsuba status | Omission documented in Tsuba? | Notes / action |
| --- | --- | --- | --- | --- |
| Entry points | `main`, async main runtime policy, library output | **Covered** | n/a | In `spec/feature-matrix.md`, `spec/language.md` |
| Functions (typed) | typed params/returns, generics, async | **Covered** | n/a | Supported subset is explicit |
| Optional/default params | `x?: T`, defaults | **Partial** | **Yes** | Defaults supported via deterministic `Option<T>` lowering; optional params (`x?: T`) remain rejected (`TSB3004`/`TSB4107`) |
| Classes | class lowering with methods/constructors | **Covered** | n/a | class → struct+impl path is covered |
| Class inheritance | `extends` | **Missing (documented)** | **Yes** | Explicitly deferred in `spec/language.md` / `spec/tsuba-v0.md` |
| Interfaces | interface contracts | **Partial** | **Yes** | Trait-like subset only (methods + explicit receiver) |
| Interface properties/optional members | broader TS interface surface | **Missing (documented)** | **Yes** | Rejected; documented as unsupported interface member forms |
| TS enums declarations | `enum` declarations | **Missing (documented)** | **Yes** | Explicitly omitted in `spec/omissions-v0.md` |
| Discriminated unions | union + exhaustive switch | **Covered** | n/a | Core path is implemented and heavily tested |
| General switch forms | broad JS/TS switch | **Partial** | **Yes** | Discriminated-union switches + scalar literal switches are supported; full JS switch surface remains restricted |
| Error handling | `try/catch/throw` | **Missing (documented)** | **Yes** | Explicitly rejected in `spec/language.md` |
| Arrays/tuples | core array/tuple operations | **Partial** | **Partly** | Basic tuples/arrays supported; spread is rejected |
| Array spread | `[...x]` | **Missing (documented)** | **Yes** | Rejected (`TSB1111`) and listed in omission matrix |
| Object literals | object literals + anonymous shapes | **Partial** | **Yes** | Strict contextual/synthesized-shape rules only |
| Object spread/rest | `{...x}` / object rest patterns | **Missing (documented)** | **Yes** | Omitted and listed in omission matrix |
| Template literals | string template expressions | **Covered** | n/a | Interpolated templates lower deterministically to Rust `format!` |
| Destructuring | binding/parameter destructuring | **Missing (documented)** | **Yes** | Omitted and listed in omission matrix |
| Optional chaining / nullish | `?.` and `??` | **Missing (documented)** | **Yes** | Explicitly rejected with stable diagnostics (`TSB1114`, `TSB1201`) |
| Module system | named imports/exports, local modules | **Covered** | n/a | Core relative imports are supported |
| Namespace imports | `import * as x` | **Missing (documented)** | **Yes** | Rejected (`TSB3209`) and listed in omission matrix |
| Side-effect imports | `import "./x.js"` | **Missing (documented)** | **Yes** | Rejected and already in diagnostics/matrix |
| Re-export barrels | `export { x } from "./m.js"` | **Missing (documented)** | **Yes** | Explicitly rejected with stable diagnostic (`TSB3214`) |
| Generators | `function*`, `yield`, `.next/.throw` flows | **Missing (documented)** | **Yes** | Omitted and listed in omission matrix |
| Async generators / for-await | `async function*`, `for await` | **Missing (documented)** | **Yes** | Omitted and listed in omission matrix |
| Type narrowing guards | `typeof`, predicates, compound guards | **Partial** | **Partly** | Union-switch narrowing exists; full TS narrowing model does not |
| TS type-level features | conditional/mapped/intersection/infer | **Missing (documented)** | **Yes** | Consolidated in omission matrix + language docs |
| Promise chaining | `.then/.catch/.finally` | **Missing (documented)** | **Yes** | Explicitly rejected and documented |
| Decorators | TS decorators | **Missing (documented)** | **Yes** | Rejected except marker-driven compile-time forms |

---

## 2) tsbindgen documented surface vs tsubabindgen

Legend:

- **Covered**: equivalent capability exists in `tsubabindgen`.
- **Partial**: analogous but weaker or different.
- **N/A (CLR-specific)**: `tsbindgen` capability exists to model CLR semantics that do not map to Rust crate surfaces.

| Area | tsbindgen documented surface | tsubabindgen status | Notes |
| --- | --- | --- | --- |
| Deterministic generation | stable ordering/output | **Covered** | Explicitly required in `spec/tsubabindgen*.md` |
| Explicit omission reporting | non-silent skip reporting | **Covered** | `tsubabindgen.report.json` contract is explicit |
| Manifest mapping | module→runtime mapping json | **Covered** | `tsuba.bindings.json` is authoritative mapping |
| Parse-failure isolation | continue generation with parse skips | **Covered** | Extractor parse errors become deterministic `parse` skip issues |
| Re-export handling | explicit `pub use` support + glob handling | **Covered** | Explicit re-exports supported, glob re-exports skipped/reported |
| Macro surfaces | macro/attr/derive emission | **Covered** | Marker-based macro model implemented/documented |
| Library mode | reuse existing generated baseline package | **Partial** | Different mechanism (crate-centric, dynamic bindgen model) |
| Internal + facade split | dual-file (`internal/index.d.ts` + facade) | **Partial** | Tsuba uses facade+bindings report; no internal mirror layer |
| Stable IDs | type/member stable IDs in bindings metadata | **Covered** | `tsuba.bindings.json` now includes deterministic symbol stable IDs (`symbols` map) |
| Phase-gate diagnostics | dedicated pipeline gate taxonomy | **Covered** | `tsubabindgen.report.json` now includes stable `phase` and `code` (`TBBxxxx`) per skip issue |
| Extension method rewrap model | sticky extension scopes and wrapper types | **N/A (CLR-specific)** | Rust trait/impl model differs; no direct equivalent needed |
| Explicit interface views / emit scopes | `ClassSurface` vs `ViewOnly` vs `Omitted` | **N/A (CLR-specific)** | Rust public item model is different |
| Property covariance unifier | CLR override compatibility recovery | **N/A (CLR-specific)** | Not a Rust crate-surface concept |
| Multi-arity family ladders | family aliasing for CLR generic families | **N/A (CLR-specific)** | Rust generic surface does not use this pattern |
| NRT propagation | nullable reference metadata flow | **N/A (CLR-specific)** | Rust nullability model differs fundamentally |

---

## 3) High-priority uncovered items (action list)

These are the highest-value gaps for “TS coverage except explicit omissions” discipline:

1. ✅ **Published a single user-facing omission matrix** (`spec/omissions-v0.md`) and linked it from language + feature docs.
2. ✅ **Explicitly rejected re-export forwarding** in compiler front-end flow (`TSB3214`) to remove partial/unsafe behavior.
3. ✅ **Implemented StableId policy for tsubabindgen**:
   - `tsuba.bindings.json` contains deterministic per-symbol `stableId` entries.
   - `tsubabindgen.report.json` contains per-skip `stableId` plus phase-gate `code`.
4. ✅ **Consolidated TS type-level omission docs** in the omission matrix + language references.

---

## 4) Summary

- Tsuba is strong on deterministic compiler/bindgen architecture and explicit diagnostics.
- Largest parity gap is still **language-surface breadth** relative to Tsonic docs.
- Most urgent issue is not just implementation; it is **documentation completeness of omissions** so unsupported TS shapes are explicit, never implicit.
