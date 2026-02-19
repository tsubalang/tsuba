import ts from "typescript";

import type { RustType } from "../ir.js";
import type { RustItem } from "../ir.js";

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

export type FileLowered = {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
  readonly uses: readonly RustItem[];
  readonly classes: readonly { readonly pos: number; readonly decl: ts.ClassDeclaration }[];
  readonly functions: readonly { readonly pos: number; readonly decl: ts.FunctionDeclaration }[];
  readonly typeAliases: readonly { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[];
  readonly interfaces: readonly { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[];
  readonly annotations: readonly {
    readonly pos: number;
    readonly node: ts.Statement;
    readonly target: string;
    readonly attrs: readonly string[];
  }[];
};
