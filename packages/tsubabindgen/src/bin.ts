import { resolve } from "node:path";
import { argv } from "node:process";

import { runGenerate } from "./generate.js";

type CliArgs = {
  manifestPath?: string;
  outDir?: string;
  packageName?: string;
  bundleCrate: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  tsubabindgen --manifest-path <Cargo.toml> --out <dir> [--package <@scope/name>] [--bundle-crate]",
      "",
    ].join("\n")
  );
}

function parseCliArgs(args: string[]): CliArgs {
  const out: CliArgs = { bundleCrate: false };
  const it = args[Symbol.iterator]();
  for (const a of it) {
    if (a === "--help" || a === "-h") usage();
    switch (a) {
      case "--manifest-path": {
        const value = it.next().value;
        if (!value) throw new Error("tsubabindgen: --manifest-path requires a value.");
        out.manifestPath = resolve(value);
        break;
      }
      case "--out": {
        const value = it.next().value;
        if (!value) throw new Error("tsubabindgen: --out requires a value.");
        out.outDir = resolve(value);
        break;
      }
      case "--package":
        out.packageName = it.next().value;
        if (!out.packageName) throw new Error("tsubabindgen: --package requires a value.");
        break;
      case "--bundle-crate":
        out.bundleCrate = true;
        break;
      default:
        throw new Error(`tsubabindgen: unknown arg ${JSON.stringify(a)}.`);
    }
  }
  if (!out.manifestPath) {
    throw new Error("tsubabindgen: missing --manifest-path.");
  }
  if (!out.outDir) {
    throw new Error("tsubabindgen: missing --out.");
  }
  return out;
}

function main(): void {
  try {
    const opts = parseCliArgs(argv.slice(2));
    const manifestPath = opts.manifestPath;
    const outDir = opts.outDir;
    if (!manifestPath || !outDir) {
      throw new Error("tsubabindgen: internal argument parse failure.");
    }
    runGenerate({
      manifestPath,
      outDir,
      ...(opts.packageName ? { packageName: opts.packageName } : undefined),
      bundleCrate: opts.bundleCrate,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    usage();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://" + process.cwd() + "/").href) {
  main();
}
