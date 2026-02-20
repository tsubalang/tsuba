# Architecture Cleanliness Audit (Wave 15)

Date: 2026-02-19  
Scope: `@tsuba/compiler` pipeline and pass contracts.

---

## 1) What was reviewed

- pass topology in `packages/compiler/src/rust/passes/*`
- orchestration boundaries in `packages/compiler/src/rust/host.ts`
- pass-output mutability guarantees at pass boundaries
- diagnostics/message-family consistency around optional/default parameter errors
- semantic coverage around generic traits/classes/interfaces and closure lowering

---

## 2) Findings

### 2.1 Pipeline structure is clean, but pass-output immutability needed hardening

The pass decomposition is clean and explicit (`bootstrap -> module-index -> file-lowering -> type-models -> annotations -> declaration/main emission -> writer`), but several pass outputs were still returned as mutable maps/arrays.

### 2.2 Closure/default-parameter semantics were present but not fully parity-audited

We already supported deterministic lowering for many function shapes, but edge coverage around:

- block-bodied closures,
- default parameter call rewriting (`None`/`Some`),
- nested generic trait/class/interface combinations

needed broader dedicated tests.

### 2.3 Diagnostic message families around optional/default params were not fully normalized

The same root causes existed across function/method/interface/constructor forms with slightly divergent wording.

---

## 3) Hardening applied in this wave

1. Pass-output immutability:
   - introduced shared `asReadonlyMap(...)` and `freezeReadonlyArray(...)` in pass contracts.
   - enforced snapshot wrappers in:
     - `module-index` pass outputs
     - `file-lowering` pass outputs
     - `annotations` pass outputs
     - `declaration-emission` output object
     - `main-emission` output array
2. Diagnostic normalization:
   - split optional vs default parameter diagnostics for constructors and interfaces where applicable.
   - normalized optional-parameter wording for interface methods to match function/method family.
3. Coverage expansion:
   - block-bodied closure support and failure-path coverage.
   - default-parameter lowering behavior coverage.
   - generic edge-case matrix coverage (generic traits/classes/interfaces with concrete impl args and nested bounds).
4. Type-alias correctness hardening:
   - plain/generic type aliases now emit deterministic Rust `type` declarations.
   - unsupported type-level alias constructs now fail fast (`TSB5206`) instead of being silently dropped.
   - default generic type arguments on aliases now fail fast (`TSB5205`).
5. Writer hardening:
   - removed inline placeholder fallbacks by emitting nested control-flow in inline block expressions (`if`/`while`/`match`).

---

## 4) Residual risks and next architecture tasks

1. `host.ts` still contains significant lowering logic; further modular extraction is still worthwhile.
2. External proof and scale rehearsals (workstream H) are still the largest parity gap.
3. Signed release tags remain open in release operations parity.
