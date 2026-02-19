import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { COMPILER_BUILD_ID, compileHostToRust, type CompileHostOutput, type RustSourceMap } from "@tsuba/compiler";

import { loadProjectContext } from "../config.js";
import { mergeCargoDependencies, renderCargoToml } from "./cargo.js";

type CargoMessageSpan = {
  readonly file_name: string;
  readonly line_start: number;
  readonly column_start: number;
};

type CargoCompilerMessage = {
  readonly reason: "compiler-message";
  readonly message: {
    readonly level: string;
    readonly message: string;
    readonly rendered?: string;
    readonly spans: readonly CargoMessageSpan[];
  };
};

export type BuildArgs = {
  readonly dir: string;
};

type BuildCacheRecord = {
  readonly schema: 1;
  readonly kind: "build-cache";
  readonly fingerprint: string;
  readonly output: CompileHostOutput;
};

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

function posToLineCol(text: string, pos: number): { readonly line: number; readonly col: number } {
  // 1-based, like most compilers.
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

function mapRustLineToSourceMap(
  map: RustSourceMap,
  rustLine: number
): { readonly fileName: string; readonly start: number; readonly end: number } | undefined {
  let best:
    | {
        readonly tsFileName: string;
        readonly tsStart: number;
        readonly tsEnd: number;
      }
    | undefined;
  for (const entry of map.entries) {
    if (entry.rustLine > rustLine) break;
    best = entry;
  }
  if (!best) return undefined;
  return { fileName: best.tsFileName, start: best.tsStart, end: best.tsEnd };
}

function firstCargoCompilerError(
  stdout: string,
  generatedRoot: string
): { readonly rendered: string; readonly span?: CargoMessageSpan } | undefined {
  const genRoot = normalizePath(generatedRoot).replaceAll(/\/+$/g, "");
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const m = obj as Partial<CargoCompilerMessage>;
    if (m.reason !== "compiler-message") continue;
    if (!m.message || typeof m.message !== "object") continue;
    if (m.message.level !== "error") continue;
    const rendered =
      typeof m.message.rendered === "string" && m.message.rendered.length > 0 ? m.message.rendered : m.message.message;
    const spans = m.message.spans ?? [];
    const isAbs = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
    const pick = spans.find((s) => {
      const fileName = normalizePath(s.file_name);
      if (!isAbs(fileName)) return true; // relative to crate root
      return fileName.startsWith(`${genRoot}/`);
    });
    return { rendered, span: pick ?? spans[0] };
  }
  return undefined;
}

function collectProjectFiles(root: string): readonly string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target" || entry.name === ".tsuba") {
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = normalizePath(abs);
      if (
        normalized.endsWith(".ts") ||
        normalized.endsWith(".tsx") ||
        normalized.endsWith("tsuba.workspace.json") ||
        normalized.endsWith("tsuba.json") ||
        normalized.endsWith("tsuba.bindings.json")
      ) {
        out.push(normalized);
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function computeBuildFingerprint(args: {
  readonly workspaceRoot: string;
  readonly entryFile: string;
  readonly runtimeKind: "none" | "tokio";
}): string {
  const hash = createHash("sha256");
  hash.update(`compiler:${COMPILER_BUILD_ID}\n`);
  hash.update(`entry:${normalizePath(args.entryFile)}\n`);
  hash.update(`runtime:${args.runtimeKind}\n`);

  const files = collectProjectFiles(args.workspaceRoot);
  for (const file of files) {
    hash.update(`file:${normalizePath(file)}\n`);
    hash.update(readFileSync(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function readBuildCache(cachePath: string): BuildCacheRecord | undefined {
  if (!existsSync(cachePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as Partial<BuildCacheRecord>;
    if (parsed.schema !== 1 || parsed.kind !== "build-cache") return undefined;
    if (typeof parsed.fingerprint !== "string" || !parsed.output || typeof parsed.output !== "object") return undefined;
    return parsed as BuildCacheRecord;
  } catch {
    return undefined;
  }
}

function tryMapRustErrorToTs(opts: {
  readonly sourceRoot: string;
  readonly rustLine: number;
  readonly rustFileName: string;
  readonly sourceMap: RustSourceMap;
}): { readonly fileName: string; readonly line: number; readonly col: number } | undefined {
  const isAbs = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  const rustFileName = normalizePath(opts.rustFileName);
  const base = rustFileName.split("/").at(-1);
  if (base !== "main.rs") return undefined;
  const parsed = mapRustLineToSourceMap(opts.sourceMap, opts.rustLine);
  if (!parsed) return undefined;
  const tsFileName = isAbs(parsed.fileName)
    ? parsed.fileName
    : normalizePath(resolve(opts.sourceRoot, parsed.fileName));
  if (!existsSync(tsFileName)) return undefined;
  const tsText = readFileSync(tsFileName, "utf-8");
  const lc = posToLineCol(tsText, parsed.start);
  return { fileName: tsFileName, line: lc.line, col: lc.col };
}

function compileCudaKernels(opts: {
  readonly generatedRoot: string;
  readonly cuda: { readonly toolkitPath: string; readonly sm: number };
  readonly kernels: readonly { readonly name: string; readonly specText: string; readonly cuSource: string }[];
}): void {
  const nvccPath = join(opts.cuda.toolkitPath, "bin", "nvcc");

  const version = spawnSync(nvccPath, ["--version"], { encoding: "utf-8" });
  if (version.status !== 0) {
    const stdout = version.stdout ?? "";
    const stderr = version.stderr ?? "";
    throw new Error(`nvcc was not found or failed to run at ${nvccPath}.\n${stdout}${stderr}`);
  }

  const kernelsDir = join(opts.generatedRoot, "kernels");
  mkdirSync(kernelsDir, { recursive: true });

  for (const k of opts.kernels) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.name)) {
      throw new Error(`Invalid kernel name '${k.name}' (must be a valid identifier in v0).`);
    }

    const cuPath = join(kernelsDir, `${k.name}.cu`);
    const ptxPath = join(kernelsDir, `${k.name}.ptx`);
    writeFileSync(cuPath, k.cuSource, "utf-8");

    const arch = `-arch=sm_${opts.cuda.sm}`;
    const res = spawnSync(nvccPath, ["--ptx", arch, "-o", ptxPath, cuPath], { encoding: "utf-8" });
    if (res.status !== 0) {
      const stdout = res.stdout ?? "";
      const stderr = res.stderr ?? "";
      throw new Error(`nvcc failed to compile ${k.name}.\n${stdout}${stderr}`);
    }
  }
}

export async function runBuild(args: BuildArgs): Promise<void> {
  const { workspaceRoot, workspace, projectRoot, project } = loadProjectContext(args.dir);

  if (project.kind !== "bin") throw new Error("Only kind=bin is supported in v0.");

  const entryFile = resolve(projectRoot, project.entry);
  const generatedRoot = join(projectRoot, workspace.generatedDirName);
  const generatedSrcDir = join(generatedRoot, "src");
  mkdirSync(generatedSrcDir, { recursive: true });
  const cachePath = join(generatedRoot, ".build-cache.json");
  const cacheStatePath = join(generatedRoot, ".build-cache-state.json");

  const fingerprint = computeBuildFingerprint({
    workspaceRoot,
    entryFile,
    runtimeKind: workspace.runtime.kind,
  });

  const cached = readBuildCache(cachePath);
  let out: CompileHostOutput;
  let cacheMode: "hit" | "miss" = "miss";
  if (cached && cached.fingerprint === fingerprint) {
    out = cached.output;
    cacheMode = "hit";
  } else {
    out = compileHostToRust({
      entryFile,
      runtimeKind: workspace.runtime.kind,
    });
    const record: BuildCacheRecord = {
      schema: 1,
      kind: "build-cache",
      fingerprint,
      output: out,
    };
    writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  }
  writeFileSync(
    cacheStatePath,
    `${JSON.stringify({ schema: 1, kind: "build-cache-state", mode: cacheMode, fingerprint }, null, 2)}\n`,
    "utf-8"
  );

  if (out.kernels.length > 0) {
    if (!project.gpu.enabled) {
      throw new Error(
        "GPU kernels were found, but this project has gpu.enabled=false. Set it to true in tsuba.json."
      );
    }

    if (workspace.gpu.backend !== "cuda") {
      throw new Error(
        "GPU kernels were found, but tsuba.workspace.json has gpu.backend='none'. Set it to 'cuda' to enable kernel compilation."
      );
    }

    const cuda = workspace.gpu.cuda;
    if (!cuda || typeof cuda.toolkitPath !== "string" || typeof cuda.sm !== "number") {
      throw new Error(
        "gpu.backend='cuda' requires gpu.cuda.toolkitPath and gpu.cuda.sm in tsuba.workspace.json."
      );
    }

    compileCudaKernels({ generatedRoot, cuda, kernels: out.kernels });
  }

  const declaredCrates =
    project.deps?.crates?.map((d) => {
      if ((d.version ? 1 : 0) + (d.path ? 1 : 0) !== 1) {
        throw new Error(
          `Invalid crate dep '${d.id}': expected exactly one of {version,path} in tsuba.json.`
        );
      }
      if (d.path) {
        return { name: d.id, package: d.package, path: resolve(projectRoot, d.path), features: d.features };
      }
      return { name: d.id, package: d.package, version: d.version!, features: d.features };
    }) ?? [];
  const crates = mergeCargoDependencies(declaredCrates, out.crates);
  const cargoToml = renderCargoToml({
    crateName: project.crate.name,
    rustEdition: workspace.rustEdition,
    deps: crates,
  });

  writeFileSync(join(generatedRoot, "Cargo.toml"), cargoToml, "utf-8");
  writeFileSync(join(generatedSrcDir, "main.rs"), out.mainRs, "utf-8");
  writeFileSync(join(generatedSrcDir, "main.rs.map.json"), `${JSON.stringify(out.sourceMap, null, 2)}\n`, "utf-8");

  const cargoTargetDir = resolve(workspaceRoot, workspace.cargoTargetDir);
  mkdirSync(cargoTargetDir, { recursive: true });

  const res = spawnSync("cargo", ["build", "--quiet", "--message-format=json"], {
    cwd: generatedRoot,
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
    encoding: "utf-8",
  });

  if (res.status !== 0) {
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const err = firstCargoCompilerError(stdout, generatedRoot);
    if (err?.span) {
      const mapped = tryMapRustErrorToTs({
        sourceRoot: dirname(entryFile),
        rustLine: err.span.line_start,
        rustFileName: err.span.file_name,
        sourceMap: out.sourceMap,
      });
      if (mapped) {
        throw new Error(`${mapped.fileName}:${mapped.line}:${mapped.col}: cargo build failed.\n${err.rendered}`);
      }
    }
    throw new Error(`cargo build failed.\n${stdout}${stderr}`);
  }
}
