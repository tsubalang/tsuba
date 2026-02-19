import ts from "typescript";

import type { RustType, Span } from "../ir.js";
import type { CompileHostOptions } from "../host.js";
import type { CompileBootstrap, MainReturnKind } from "./contracts.js";

type BootstrapPassDeps = {
  readonly fail: (code: string, message: string, span?: Span) => never;
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly getExportedMain: (sf: ts.SourceFile) => ts.FunctionDeclaration;
  readonly hasModifier: (
    node: ts.Node & { readonly modifiers?: readonly ts.ModifierLike[] },
    kind: ts.SyntaxKind
  ) => boolean;
  readonly unwrapPromiseInnerType: (
    node: ts.Node,
    context: string,
    typeNode: ts.TypeNode | undefined,
    code: string
  ) => ts.TypeNode;
  readonly typeNodeToRust: (typeNode: ts.TypeNode) => RustType;
  readonly isInNodeModules: (fileName: string) => boolean;
  readonly syntheticSpanForFile: (fileName: string) => Span;
  readonly mapSpanFileName: (fileName: string) => string;
};

export function runBootstrapPass(opts: CompileHostOptions, deps: BootstrapPassDeps): CompileBootstrap {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const program = ts.createProgram([opts.entryFile], compilerOptions, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const d = diagnostics.at(0);
    if (!d) deps.fail("TSB0002", "Compilation failed with diagnostics.", deps.syntheticSpanForFile(opts.entryFile));
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      deps.fail("TSB0002", `${deps.mapSpanFileName(d.file.fileName)}:${pos.line + 1}:${pos.character + 1}: ${msg}`, {
        fileName: deps.mapSpanFileName(d.file.fileName),
        start: d.start,
        end: d.length !== undefined ? d.start + d.length : d.start,
      });
    }
    deps.fail("TSB0002", msg, deps.syntheticSpanForFile(opts.entryFile));
  }
  const checker = program.getTypeChecker();

  const entrySourceFile = program.getSourceFile(opts.entryFile);
  if (!entrySourceFile) deps.fail("TSB0001", `Could not read entry file: ${opts.entryFile}`, deps.syntheticSpanForFile(opts.entryFile));

  const mainFn = deps.getExportedMain(entrySourceFile);
  const runtimeKind = opts.runtimeKind ?? "none";
  const mainIsAsync = deps.hasModifier(mainFn, ts.SyntaxKind.AsyncKeyword);
  const returnTypeNode = mainFn.type;
  const returnKind: MainReturnKind = (() => {
    if (mainIsAsync) {
      if (runtimeKind !== "tokio") {
        deps.failAt(mainFn, "TSB1004", "async main() requires runtime.kind='tokio' in tsuba.workspace.json.");
      }
      const inner = deps.unwrapPromiseInnerType(mainFn, "main()", returnTypeNode, "TSB1003");
      if (inner.kind === ts.SyntaxKind.VoidKeyword) return "unit";
      if (
        ts.isTypeReferenceNode(inner) &&
        ts.isIdentifier(inner.typeName) &&
        inner.typeName.text === "Result"
      ) {
        const [okTy] = inner.typeArguments ?? [];
        if (!okTy || okTy.kind !== ts.SyntaxKind.VoidKeyword) {
          deps.failAt(mainFn, "TSB1003", "async main() may only return Promise<void> or Promise<Result<void, E>> in v0.");
        }
        return "result";
      }
      deps.failAt(mainFn, "TSB1003", "async main() may only return Promise<void> or Promise<Result<void, E>> in v0.");
    }

    if (!returnTypeNode) return "unit";
    if (returnTypeNode.kind === ts.SyntaxKind.VoidKeyword) return "unit";
    if (
      ts.isTypeReferenceNode(returnTypeNode) &&
      ts.isIdentifier(returnTypeNode.typeName) &&
      returnTypeNode.typeName.text === "Result"
    ) {
      const [okTy] = returnTypeNode.typeArguments ?? [];
      if (!okTy || okTy.kind !== ts.SyntaxKind.VoidKeyword) {
        deps.failAt(mainFn, "TSB1003", "main() may only return Result<void, E> in v0.");
      }
      return "result";
    }
    deps.failAt(mainFn, "TSB1003", "main() must return void or Result<void, E> in v0.");
  })();

  const rustReturnType = (() => {
    if (returnKind !== "result") return undefined;
    if (mainIsAsync) {
      const inner = deps.unwrapPromiseInnerType(mainFn, "main()", returnTypeNode, "TSB1003");
      return deps.typeNodeToRust(inner);
    }
    if (!returnTypeNode) {
      deps.failAt(mainFn, "TSB1003", "main() must return void or Result<void, E> in v0.");
    }
    return deps.typeNodeToRust(returnTypeNode);
  })();

  const userSourceFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !deps.isInNodeModules(f.fileName));

  return Object.freeze({
    program,
    checker,
    entrySourceFile,
    mainFn,
    runtimeKind,
    mainIsAsync,
    returnKind,
    rustReturnType,
    userSourceFiles: Object.freeze([...userSourceFiles]),
  });
}
