import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { compileHostToRust } from "@tsuba/compiler";

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

type WorkspaceConfig = {
  readonly schema: number;
  readonly rustEdition: "2021" | "2024";
  readonly packagesDir: string;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
  readonly gpu: {
    readonly backend: "none" | "cuda";
  };
};

type ProjectConfig = {
  readonly schema: number;
  readonly name: string;
  readonly kind: "bin" | "lib";
  readonly entry: string;
  readonly crate: {
    readonly name: string;
  };
  readonly deps?: {
    readonly crates?: readonly {
      readonly id: string;
      readonly version?: string;
      readonly path?: string;
      readonly features?: readonly string[];
    }[];
  };
};

export type BuildArgs = {
  readonly dir: string;
};

function readJson<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as T;
}

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

function parseSpanComment(line: string): { readonly fileName: string; readonly start: number; readonly end: number } | undefined {
  const trimmed = line.trimStart();
  const prefix = "// tsuba-span: ";
  if (!trimmed.startsWith(prefix)) return undefined;
  const rest = trimmed.slice(prefix.length);
  const last = rest.lastIndexOf(":");
  if (last === -1) return undefined;
  const secondLast = rest.lastIndexOf(":", last - 1);
  if (secondLast === -1) return undefined;
  const fileName = rest.slice(0, secondLast);
  const startText = rest.slice(secondLast + 1, last);
  const endText = rest.slice(last + 1);
  const start = Number.parseInt(startText, 10);
  const end = Number.parseInt(endText, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start < 0 || end < start) return undefined;
  return { fileName, start, end };
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

function tryMapRustErrorToTs(opts: {
  readonly generatedRoot: string;
  readonly rustFileName: string;
  readonly rustLine: number;
}): { readonly fileName: string; readonly line: number; readonly col: number } | undefined {
  const isAbs = (p: string): boolean => p.startsWith("/") || /^[A-Za-z]:\//.test(p);
  const rustFileName = isAbs(opts.rustFileName) ? opts.rustFileName : join(opts.generatedRoot, opts.rustFileName);
  const rustText = readFileSync(rustFileName, "utf-8");
  const rustLines = rustText.split(/\r?\n/g);
  for (let i = Math.min(opts.rustLine - 1, rustLines.length - 1); i >= 0; i--) {
    const parsed = parseSpanComment(rustLines[i]!);
    if (!parsed) continue;
    const tsText = readFileSync(parsed.fileName, "utf-8");
    const lc = posToLineCol(tsText, parsed.start);
    return { fileName: parsed.fileName, line: lc.line, col: lc.col };
  }
  return undefined;
}

function findWorkspaceRoot(fromDir: string): string {
  let cur = resolve(fromDir);
  while (true) {
    const candidate = join(cur, "tsuba.workspace.json");
    try {
      readFileSync(candidate, "utf-8");
      return cur;
    } catch {
      // continue
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Could not find tsuba.workspace.json in this directory or any parent.");
}

function findProjectRoot(fromDir: string): string {
  let cur = resolve(fromDir);
  while (true) {
    const candidate = join(cur, "tsuba.json");
    try {
      readFileSync(candidate, "utf-8");
      return cur;
    } catch {
      // continue
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error("Could not find tsuba.json in this directory or any parent.");
}

export async function runBuild(args: BuildArgs): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(args.dir);
  const workspace = readJson<WorkspaceConfig>(join(workspaceRoot, "tsuba.workspace.json"));
  const projectRoot = findProjectRoot(args.dir);
  const project = readJson<ProjectConfig>(join(projectRoot, "tsuba.json"));

  if (workspace.schema !== 1) throw new Error("Unsupported tsuba.workspace.json schema.");
  if (project.schema !== 1) throw new Error("Unsupported tsuba.json schema.");

  if (project.kind !== "bin") throw new Error("Only kind=bin is supported in v0.");

  const entryFile = resolve(projectRoot, project.entry);
  const out = compileHostToRust({ entryFile });

  if (out.kernels.length > 0) {
    if (workspace.gpu.backend !== "cuda") {
      throw new Error(
        "GPU kernels were found, but tsuba.workspace.json has gpu.backend='none'. Set it to 'cuda' to enable kernel compilation."
      );
    }

    const nvcc = spawnSync("nvcc", ["--version"], { encoding: "utf-8" });
    if (nvcc.status !== 0) {
      const stderr = nvcc.stderr ?? "";
      throw new Error(`gpu.backend='cuda' but nvcc was not found.\n${stderr}`);
    }

    throw new Error("gpu.backend='cuda' is not implemented yet in v0 (kernel compilation pending).");
  }

  const generatedRoot = join(projectRoot, workspace.generatedDirName);
  const generatedSrcDir = join(generatedRoot, "src");
  mkdirSync(generatedSrcDir, { recursive: true });

  const declaredCrates =
    project.deps?.crates?.map((d) => {
      if ((d.version ? 1 : 0) + (d.path ? 1 : 0) !== 1) {
        throw new Error(
          `Invalid crate dep '${d.id}': expected exactly one of {version,path} in tsuba.json.`
        );
      }
      if (d.path) {
        return { name: d.id, path: resolve(projectRoot, d.path), features: d.features };
      }
      return { name: d.id, version: d.version!, features: d.features };
    }) ?? [];
  const crates = mergeCargoDependencies(declaredCrates, out.crates);
  const cargoToml = renderCargoToml({
    crateName: project.crate.name,
    rustEdition: workspace.rustEdition,
    deps: crates,
  });

  writeFileSync(join(generatedRoot, "Cargo.toml"), cargoToml, "utf-8");
  writeFileSync(join(generatedSrcDir, "main.rs"), out.mainRs, "utf-8");

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
        generatedRoot,
        rustFileName: err.span.file_name,
        rustLine: err.span.line_start,
      });
      if (mapped) {
        throw new Error(`${mapped.fileName}:${mapped.line}:${mapped.col}: cargo build failed.\n${err.rendered}`);
      }
    }
    throw new Error(`cargo build failed.\n${stdout}${stderr}`);
  }
}
