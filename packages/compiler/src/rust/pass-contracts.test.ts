import { expect } from "chai";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CompileError, compileHostToRust } from "./host.js";

describe("@tsuba/compiler pass contracts", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function readTsSource(path: string): { readonly text: string; readonly sf: ts.SourceFile } {
    const text = readFileSync(path, "utf-8");
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return { text, sf };
  }

  function getFunctionBodyText(path: string, name: string): string {
    const { text, sf } = readTsSource(path);
    let found: ts.FunctionDeclaration | undefined;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
        found = st;
        break;
      }
    }
    expect(found, `Function '${name}' must exist in ${path}`).to.not.equal(undefined);
    expect(found?.body, `Function '${name}' in ${path} must have a body`).to.not.equal(undefined);
    const body = found!.body!;
    return text.slice(body.pos, body.end);
  }

  it("keeps compileHostToRustImpl pass boundaries explicit", () => {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const body = getFunctionBodyText(hostPath, "compileHostToRustImpl");
    expect(body).to.contain("const bootstrap = runBootstrapPass(opts, {");
    expect(body).to.contain("const kernels = collectSortedKernelDecls(ctx, userSourceFiles);");
    expect(body).to.contain("createUserModuleIndexPass(userSourceFiles, entryFileName, {");
    expect(body).to.contain("const loweredByFile = collectFileLoweringsPass(");
    expect(body).to.contain("const hirByFile = buildHirModulesPass(loweredByFile);");
    expect(body).to.contain("collectTypeModelsPass(hirByFile, {");
    expect(body).to.contain("const attrsByFile = collectAnnotationsPass(hirByFile, entryFileName, mainFn, {");
    expect(body).to.contain("const declarationPhase = emitModuleAndRootDeclarationsPass(");
    expect(body).to.contain("const mainItems = emitMainAndRootShapesPass(");

    expect(body).to.not.contain("ts.createProgram(");
    expect(body).to.not.contain("ts.getPreEmitDiagnostics(");
    expect(body).to.not.contain("ts.createCompilerHost(");
    expect(body).to.not.contain("ts.isImportDeclaration(");
    expect(body).to.not.contain("const ann = ");
    expect(body).to.not.contain("const rootGroups");
    expect(body).to.not.contain("const moduleFiles");
  });

  it("keeps bootstrap TS-program wiring isolated in bootstrap pass", () => {
    const bootstrapPath = join(repoRoot(), "packages", "compiler", "src", "rust", "passes", "bootstrap.ts");
    const body = getFunctionBodyText(bootstrapPath, "runBootstrapPass");
    expect(body).to.contain("const host = ts.createCompilerHost(compilerOptions, true);");
    expect(body).to.contain("const program = ts.createProgram([opts.entryFile], compilerOptions, host);");
    expect(body).to.contain("getPreEmitDiagnostics(program)");
  });

  it("keeps CUDA runtime text emission isolated from host lowering", () => {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const hostSource = readFileSync(hostPath, "utf-8");
    expect(hostSource).to.contain('import { renderCudaRuntimeModule } from "./cuda-runtime.js";');
    expect(hostSource).to.not.contain("function renderCudaRuntimeModule(");

    const runtimePath = join(repoRoot(), "packages", "compiler", "src", "rust", "cuda-runtime.ts");
    const runtimeSource = readFileSync(runtimePath, "utf-8");
    expect(runtimeSource).to.contain("export function renderCudaRuntimeModule(");
    expect(runtimeSource).to.contain("mod __tsuba_cuda {");
  });

  it("keeps host utility/bindings helpers isolated in lowering modules", () => {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const hostSource = readFileSync(hostPath, "utf-8");
    expect(hostSource).to.contain('from "./lowering/common.js";');
    expect(hostSource).to.contain('from "./lowering/bindings-manifest.js";');
    expect(hostSource).to.contain('from "./lowering/union-model.js";');
    expect(hostSource).to.not.contain("function rustTypeNameFromTag(");
    expect(hostSource).to.not.contain("function anonStructName(");
    expect(hostSource).to.not.contain("function findNodeModulesPackageRoot(");
    expect(hostSource).to.not.contain("function readBindingsManifest(");
    expect(hostSource).to.not.contain("function unionDefFromIdentifier(");
  });

  it("keeps rust source-map generation isolated from host lowering", () => {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const hostSource = readFileSync(hostPath, "utf-8");
    expect(hostSource).to.contain('from "./source-map.js";');
    expect(hostSource).to.contain("const sourceMap = buildRustSourceMap(mainRs);");
    expect(hostSource).to.contain("return { mainRs, kernels, crates, sourceMap };");

    const sourceMapPath = join(repoRoot(), "packages", "compiler", "src", "rust", "source-map.ts");
    const sourceMapSource = readFileSync(sourceMapPath, "utf-8");
    expect(sourceMapSource).to.contain("export function buildRustSourceMap(");
    expect(sourceMapSource).to.contain("export function mapRustLineToTs(");
  });

  it("keeps kernel dialect lowering isolated from host orchestration", () => {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const hostSource = readFileSync(hostPath, "utf-8");
    expect(hostSource).to.contain('from "./kernel-dialect.js";');
    expect(hostSource).to.not.contain("function lowerKernelExprToCuda(");
    expect(hostSource).to.not.contain("function lowerKernelStmtToCuda(");
    expect(hostSource).to.not.contain("function lowerKernelToCudaSource(");

    const dialectPath = join(repoRoot(), "packages", "compiler", "src", "rust", "kernel-dialect.ts");
    const dialectSource = readFileSync(dialectPath, "utf-8");
    expect(dialectSource).to.contain("export function collectKernelDecls(");
    expect(dialectSource).to.contain("function lowerKernelExprToCuda(");
    expect(dialectSource).to.contain("function lowerKernelStmtToCuda(");
    expect(dialectSource).to.contain("function lowerKernelToCudaSource(");
  });

  it("routes entry-body lowering through MIR pass before emission", () => {
    const mainEmissionPath = join(
      repoRoot(),
      "packages",
      "compiler",
      "src",
      "rust",
      "passes",
      "main-emission.ts"
    );
    const body = getFunctionBodyText(mainEmissionPath, "emitMainAndRootShapesPass");
    expect(body).to.contain("lowerRustBodyToMirPass(");
    expect(body).to.contain("emitMirBodyToRustStmtsPass(");
  });

  it("uses readonly map wrappers inside module-index pass outputs", () => {
    const moduleIndexPath = join(repoRoot(), "packages", "compiler", "src", "rust", "passes", "module-index.ts");
    const body = getFunctionBodyText(moduleIndexPath, "createUserModuleIndexPass");
    expect(body).to.contain("userFilesByName: asReadonlyMap(userFilesByName)");
    expect(body).to.contain("moduleNameByFile: asReadonlyMap(moduleNameByFile)");
  });

  it("enforces immutable pass outputs (snapshot map/array wrappers)", () => {
    const fileLoweringPath = join(
      repoRoot(),
      "packages",
      "compiler",
      "src",
      "rust",
      "passes",
      "file-lowering.ts"
    );
    const fileLoweringBody = getFunctionBodyText(fileLoweringPath, "collectFileLoweringsPass");
    expect(fileLoweringBody).to.contain("Object.freeze({");
    expect(fileLoweringBody).to.contain("freezeReadonlyArray(uses)");
    expect(fileLoweringBody).to.contain("return asReadonlyMap(loweredByFile);");

    const annotationsPath = join(
      repoRoot(),
      "packages",
      "compiler",
      "src",
      "rust",
      "passes",
      "annotations.ts"
    );
    const annotationsBody = getFunctionBodyText(annotationsPath, "collectAnnotationsPass");
    expect(annotationsBody).to.contain("attrsByName.set(a.target, freezeReadonlyArray(list));");
    expect(annotationsBody).to.contain("attrsByFile.set(fileName, asReadonlyMap(attrsByName));");
    expect(annotationsBody).to.contain("return asReadonlyMap(attrsByFile);");

    const declPath = join(
      repoRoot(),
      "packages",
      "compiler",
      "src",
      "rust",
      "passes",
      "declaration-emission.ts"
    );
    const declBody = getFunctionBodyText(declPath, "emitModuleAndRootDeclarationsPass");
    expect(declBody).to.contain("items: freezeReadonlyArray(items)");
    expect(declBody).to.contain("rootAttrs: asReadonlyMap(rootAttrs)");

    const mainPath = join(
      repoRoot(),
      "packages",
      "compiler",
      "src",
      "rust",
      "passes",
      "main-emission.ts"
    );
    const mainBody = getFunctionBodyText(mainPath, "emitMainAndRootShapesPass");
    expect(mainBody).to.contain("return freezeReadonlyArray(items);");
  });

  it("reports a synthetic span when the entry file is missing", () => {
    const missingEntry = join(tmpdir(), "tsuba-pass-contracts-missing", "main.ts");
    let err: unknown;
    try {
      compileHostToRust({ entryFile: missingEntry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CompileError);
    const ce = err as CompileError;
    expect(["TSB0001", "TSB0002"]).to.contain(ce.code);
    expect(ce.span).to.not.equal(undefined);
    expect(ce.span?.fileName).to.match(/main\.ts$/);
    expect(ce.span?.start).to.equal(0);
    expect(ce.span?.end).to.equal(0);
  });

  it("reports pre-emit TypeScript diagnostics with actionable spans", () => {
    const dir = makeRepoTempDir("compiler-pass-preemit-diag-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "export function main(): void {",
        '  const value: number = "not-a-number";',
        "  void value;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      compileHostToRust({ entryFile: entry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CompileError);
    const ce = err as CompileError;
    expect(ce.code).to.equal("TSB0002");
    expect(ce.message).to.contain("main.ts:");
    expect(ce.span).to.not.equal(undefined);
    expect(ce.span?.fileName).to.match(/main\.ts$/);
    expect(ce.span?.end).to.be.gte(ce.span?.start ?? 0);
  });
});
