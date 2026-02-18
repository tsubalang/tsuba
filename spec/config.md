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
  "crate": {
    "name": "my_api"
  },
  "deps": {
    "crates": [
      { "id": "tokio", "version": "1.37", "features": ["rt-multi-thread", "macros"] },
      { "id": "serde", "version": "1.0", "features": ["derive"] }
    ]
  }
}
```

Fields (v0):

- `schema` (number)
- `name` (string): project name (also default crate base name).
- `kind` (`"bin"` | `"lib"`)
- `entry` (string): entry TS file.
- `crate.name` (string): Rust crate name (snake_case recommended). If omitted, derived from `name`.
- `deps.crates[]`: declared Cargo dependencies (normally managed by `tsuba add crate`).

## `tsuba.bindings.json`

Bindings manifest shipped inside generated/installed Tsuba packages.

This is used by the Tsuba compiler for **import resolution**: mapping a TS module specifier to a Rust module path inside a crate.

Example:

```json
{
  "schema": 1,
  "kind": "crate",
  "crate": { "name": "axum", "version": "0.7.5" },
  "modules": {
    "@tsuba/axum/index.js": "axum",
    "@tsuba/axum/routing.js": "axum::routing",
    "@tsuba/axum/extract.js": "axum::extract"
  }
}
```

Rules:

- Keys are TS import specifiers used by user code.
- Values are Rust paths used by codegen.
- The manifest must be deterministic and complete for the published surface.

