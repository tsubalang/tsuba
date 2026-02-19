import { resolve } from "node:path";

import { runGenerate } from "@tsuba/tsubabindgen";

export type BindgenArgs = {
  readonly dir: string;
  readonly argv: readonly string[];
};

export type BindgenParsed = {
  readonly manifestPath: string;
  readonly outDir: string;
  readonly packageName?: string;
  readonly bundleCrate: boolean;
};

export type BindgenGenerate = (opts: {
  readonly manifestPath: string;
  readonly outDir: string;
  readonly packageName?: string;
  readonly bundleCrate: boolean;
}) => void;

export function parseBindgenArgs(args: BindgenArgs): BindgenParsed {
  let manifestPath: string | undefined;
  let outDir: string | undefined;
  let packageName: string | undefined;
  let bundleCrate = false;

  const it = args.argv[Symbol.iterator]();
  while (true) {
    const next = it.next();
    if (next.done) break;
    const a = next.value;
    switch (a) {
      case "--manifest-path": {
        const v = it.next();
        if (v.done) throw new Error("bindgen: --manifest-path requires a value");
        manifestPath = resolve(args.dir, v.value);
        break;
      }
      case "--out": {
        const v = it.next();
        if (v.done) throw new Error("bindgen: --out requires a value");
        outDir = resolve(args.dir, v.value);
        break;
      }
      case "--package": {
        const v = it.next();
        if (v.done) throw new Error("bindgen: --package requires a value");
        packageName = v.value;
        break;
      }
      case "--bundle-crate":
        bundleCrate = true;
        break;
      case "--help":
      case "-h":
        throw new Error(
          "Usage: tsuba bindgen --manifest-path <Cargo.toml> --out <dir> [--package <@scope/name>] [--bundle-crate]"
        );
      default:
        throw new Error(`bindgen: unknown arg: ${a}`);
    }
  }

  if (!manifestPath) {
    throw new Error("bindgen: missing required --manifest-path <Cargo.toml>");
  }
  if (!outDir) {
    throw new Error("bindgen: missing required --out <dir>");
  }

  return { manifestPath, outDir, packageName, bundleCrate };
}

export async function runBindgen(
  args: BindgenArgs,
  deps?: { readonly generate?: BindgenGenerate }
): Promise<void> {
  const parsed = parseBindgenArgs(args);
  const generate = deps?.generate ?? runGenerate;
  generate({
    manifestPath: parsed.manifestPath,
    outDir: parsed.outDir,
    packageName: parsed.packageName,
    bundleCrate: parsed.bundleCrate,
  });
}
