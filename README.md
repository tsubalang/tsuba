# Tsuba

Tsuba is an **airplane-grade** language/toolchain that uses **TypeScript** as its surface syntax and lowers to **Rust** (host) and **CUDA/PTX** (kernels).

Specs live in `spec/README.md`.

## Requirements

- Node.js >= 22
- Rust toolchain (`rustc`, `cargo`)

## Repo quickstart

```bash
npm install
npm run run-all
```

## Testing workflow

Fast iteration (focused):

```bash
npm run test:cli -- --grep "<pattern>"
npm run test:compiler -- --grep "<pattern>"
bash test/scripts/run-all.sh --no-unit --filter <fixture>
```

Final verification (required before merge/publish):

```bash
npm run run-all
```

`run-all` runs:

- unit + compiler suites
- fixture TypeScript typecheck
- fixture E2E (build/run/test)
- Rust golden snapshot checks (`golden/main.rs` via fixture metadata)
- clean temp-dir CLI smoke workflow (`init/build/run/test/add/bindgen`)
- diagnostic quality baseline check (`scripts/check-diagnostic-quality.mjs`)
- external proof matrix verification (`scripts/verify-external-proof.mjs`, best-effort unless required)

## Release preflight (npm)

Use the publish script for invariant checks + publish flow:

```bash
npm run publish:npm -- --dry-run
```

For crates.io (when publishable crates exist in this repo):

```bash
npm run publish:crates -- --dry-run
```

It enforces:

- branch is `main`
- clean working tree
- local `main` matches `origin/main`
- full `npm run run-all` gate (unless `--no-tests` is explicitly passed)
- required proof verification via `scripts/verify-proof.sh --require` (unless `--no-proof` is explicitly passed)
- required external proof matrix verification via `scripts/verify-external-proof.mjs --require` (unless `--no-external-proof` is explicitly passed)
- required signed-tag presence on `HEAD` via `scripts/check-signed-head-tag.mjs --require` (unless `--no-signed-tag` is explicitly passed)
- package versions are not already published on npm

Optional external proof verification (if the sibling repo exists):

```bash
npm run verify:proof
npm run verify:external-proof
```

## Using the CLI (from this repo checkout)

Build the CLI:

```bash
npm run -w @tsuba/cli build
```

Initialize a workspace (in an empty directory):

```bash
node /path/to/tsuba/packages/cli/dist/bin.js init
```

Build a project (generates Rust + runs `cargo build`), from inside a project directory (e.g. `packages/<project>`):

```bash
node /path/to/tsuba/packages/cli/dist/bin.js build
```

Run a project (builds + runs `cargo run`), from inside a project directory:

```bash
node /path/to/tsuba/packages/cli/dist/bin.js run
```
