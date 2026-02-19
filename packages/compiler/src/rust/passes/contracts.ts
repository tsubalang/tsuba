import ts from "typescript";

import type { RustType } from "../ir.js";

export type MainReturnKind = "unit" | "result";

export type CompileBootstrap = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly entrySourceFile: ts.SourceFile;
  readonly mainFn: ts.FunctionDeclaration;
  readonly runtimeKind: "none" | "tokio";
  readonly mainIsAsync: boolean;
  readonly returnKind: MainReturnKind;
  readonly rustReturnType?: RustType;
  readonly userSourceFiles: readonly ts.SourceFile[];
};

export type UserModuleIndex = {
  readonly userFilesByName: ReadonlyMap<string, ts.SourceFile>;
  readonly moduleNameByFile: ReadonlyMap<string, string>;
};
