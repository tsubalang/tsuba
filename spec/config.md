# Tsuba config files (v0)

Tsuba uses a small set of JSON config files.

## `tsuba.workspace.json`

Workspace-wide configuration.

Example:

```json
{
  "schema": 1,
  "rustEdition": "2021",
  "packagesDir": "packages",
  "generatedDirName": "generated",
  "cargoTargetDir": ".tsuba/target",
  "gpu": {
    "backend": "cuda",
    "cuda": {
      "toolkitPath": "/usr/local/cuda",
      "sm": 90
    }
  },
  "runtime": {
    "kind": "tokio"
  }
}
```

Fields (v0):

- `schema` (number): schema version.
- `rustEdition` (`"2021"` | `"2024"`): Rust edition used for generated crates.
- `packagesDir` (string): where project packages live.
- `generatedDirName` (string): directory name for generated Rust sources.
- `cargoTargetDir` (string): workspace-wide Cargo target dir.
- `gpu.backend` (`"none"` | `"cuda"`): GPU backend selection.
- `gpu.cuda.toolkitPath` (string): CUDA toolkit root (required when `gpu.backend === "cuda"`).
- `gpu.cuda.sm` (number): target compute capability (e.g. `80`, `86`, `90`).
- `runtime.kind` (`"none"` | `"tokio"`): async runtime selection.

## `tsuba.json`

Per-project configuration.

Example:

```json
{
  "schema": 1,
  "name": "my-api",
  "kind": "bin",
  "entry": "src/main.ts",
  "gpu": { "enabled": true },
  "crate": {
    "name": "my_api"
  },
  "deps": {
    "crates": [
      { "id": "tokio", "version": "1.37", "features": ["rt-multi-thread", "macros"] },
      { "id": "serde", "version": "1.0", "features": ["derive"] },
      { "id": "simple_crate", "package": "simple-crate", "version": "0.1.0" }
    ]
  }
}
```

Fields (v0):

- `schema` (number)
- `name` (string): project name (also default crate base name).
- `kind` (`"bin"` | `"lib"`)
- `entry` (string): entry TS file.
- `gpu.enabled` (boolean): whether this project can compile/launch kernels (requires workspace GPU backend).
- `crate.name` (string): Rust crate name (snake_case recommended). If omitted, derived from `name`.
- `deps.crates[]`: declared Cargo dependencies (normally managed by `tsuba add crate`).
  - `id` is the Rust **crate name** used in `use` paths (often underscores).
  - `package` is the Cargo **package name** when it differs from `id` (often hyphens).
    - Example: `simple-crate` package is imported as `simple_crate` in Rust, so use `{ "id": "simple_crate", "package": "simple-crate", ... }`.
  - Airplane-grade policy (v0): **single version per workspace** for a given Cargo package.
    - If two projects request different versions of the same package, Tsuba errors and requires you to align versions.

## `tsuba.bindings.json`

Bindings manifest shipped inside generated/installed Tsuba packages.

This is used by the Tsuba compiler for **import resolution**: mapping a TS module specifier to a Rust module path inside a crate.

Example:

```json
{
  "schema": 1,
  "kind": "crate",
  "crate": {
    "name": "axum",
    "package": "axum",
    "version": "0.7.5"
  },
  "modules": {
    "@tsuba/axum/index.js": "axum",
    "@tsuba/axum/routing.js": "axum::routing",
    "@tsuba/axum/extract.js": "axum::extract"
  },
  "symbols": {
    "axum::struct:Router<S>": { "kind": "struct", "stableId": "4ab73fd7b7b7d988" },
    "axum::fn:fn:serve(listener:TokioTcpListener,make_service:MakeService):Result<(), Error>": {
      "kind": "fn",
      "stableId": "8f31ac2b9f5f6114"
    }
  }
}
```

Rules:

- Keys are TS import specifiers used by user code.
- Values are Rust paths used by codegen.
- The manifest must be deterministic and complete for the published surface.

Stable symbol index:

- `symbols` is a deterministic map keyed by canonical Rust symbol identity.
- Each symbol entry includes:
  - `kind`: declaration category (`fn`, `struct`, `trait`, `enum`, etc.)
  - `stableId`: deterministic hash for diff tooling/regression checks
- Compiler resolution only requires `modules`; `symbols` is for tooling, auditing, and bindgen traceability.

Crate identity:

- `crate.name` (string): the Rust **crate name** used in paths (normally the Cargo `lib` target name, e.g. `simple_crate`).
- `crate.package` (string, optional): the Cargo **package** name for dependency resolution when it differs from the crate name (e.g. package `simple-crate` with crate `simple_crate`).
- `crate.version` (string) **or** `crate.path` (string): exactly one must be present.
  - `crate.version`: consume from crates.io (requires network / existing Cargo cache).
  - `crate.path`: consume from a local path (typically a bundled crate inside the npm package).
    - Relative paths are resolved relative to the `tsuba.bindings.json` file.
