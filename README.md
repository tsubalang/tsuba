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

## Release preflight (npm)

Use the publish script for invariant checks + publish flow:

```bash
npm run publish:npm -- --dry-run
```

It enforces:

- branch is `main`
- clean working tree
- local `main` matches `origin/main`
- full `npm run run-all` gate (unless `--no-tests` is explicitly passed)
- package versions are not already published on npm

Optional external proof verification (if the sibling repo exists):

```bash
npm run verify:proof
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
