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

## Using the CLI (from this repo checkout)

Build the CLI:

```bash
npm run -w @tsuba/cli build
```

Initialize a workspace (in an empty directory):

```bash
node /path/to/tsuba/packages/cli/dist/bin.js init
```

Build a project (generates Rust + runs `cargo build`):

```bash
node /path/to/tsuba/packages/cli/dist/bin.js build
```

Run a project (builds + runs `cargo run`):

```bash
node /path/to/tsuba/packages/cli/dist/bin.js run
```
