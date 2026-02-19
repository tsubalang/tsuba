import ts from "typescript";

import type { RustItem } from "../ir.js";
import {
  asReadonlyMap,
  freezeReadonlyArray,
  type HirDecl,
  type HirModule,
  type ShapeStructDefLike,
} from "./contracts.js";

type DeclarationEmissionPassDeps<TCtx> = {
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly compareText: (a: string, b: string) => number;
  readonly sortUseItems: (items: readonly RustItem[]) => readonly RustItem[];
  readonly lowerTypeAlias: (
    ctx: TCtx,
    decl: ts.TypeAliasDeclaration,
    attrs: readonly string[]
  ) => readonly RustItem[];
  readonly lowerInterface: (ctx: TCtx, decl: ts.InterfaceDeclaration) => readonly RustItem[];
  readonly lowerClass: (ctx: TCtx, decl: ts.ClassDeclaration, attrs: readonly string[]) => readonly RustItem[];
  readonly lowerFunction: (ctx: TCtx, decl: ts.FunctionDeclaration, attrs: readonly string[]) => RustItem;
  readonly getShapeStructsByFile: (fileName: string) => readonly ShapeStructDefLike[];
  readonly structItemFromDef: (def: ShapeStructDefLike, attrs: readonly string[]) => RustItem;
};

export type DeclarationEmissionOutput = {
  readonly items: readonly RustItem[];
  readonly rootAttrs: ReadonlyMap<string, readonly string[]>;
};

export function emitModuleAndRootDeclarationsPass<TCtx>(
  ctx: TCtx,
  entrySourceFile: ts.SourceFile,
  entryFileName: string,
  hirByFile: ReadonlyMap<string, HirModule>,
  moduleNameByFile: ReadonlyMap<string, string>,
  attrsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  deps: DeclarationEmissionPassDeps<TCtx>
): DeclarationEmissionOutput {
  const items: RustItem[] = [];

  const rootModule = hirByFile.get(entryFileName);
  if (!rootModule) deps.failAt(entrySourceFile, "TSB0001", "Internal error: entry file missing from HIR set.");

  items.push(...deps.sortUseItems(rootModule.uses));

  const lowerDecl = (decl: HirDecl, attrsForDecl: readonly string[]): readonly RustItem[] => {
    if (decl.kind === "typeAlias") return deps.lowerTypeAlias(ctx, decl.decl, attrsForDecl);
    if (decl.kind === "interface") return deps.lowerInterface(ctx, decl.decl);
    if (decl.kind === "class") return deps.lowerClass(ctx, decl.decl, attrsForDecl);
    return [deps.lowerFunction(ctx, decl.decl, attrsForDecl)];
  };

  const moduleFiles = [...moduleNameByFile.entries()].sort((a, b) => deps.compareText(a[0], b[0]));
  for (const [fileName, modName] of moduleFiles) {
    const module = hirByFile.get(fileName);
    if (!module) continue;
    const fileAttrs = attrsByFile.get(fileName) ?? asReadonlyMap(new Map<string, readonly string[]>());

    const declItems = module.declarations.flatMap((decl) => {
      const declName =
        decl.kind === "typeAlias"
          ? decl.decl.name.text
          : decl.kind === "interface"
            ? ""
            : decl.decl.name?.text ?? "";
      return lowerDecl(decl, fileAttrs.get(declName) ?? []);
    });

    const usesSorted = deps.sortUseItems(module.uses);
    const shapeStructs = [...deps.getShapeStructsByFile(fileName)].sort(
      (a, b) => a.span.start - b.span.start || deps.compareText(a.key, b.key)
    );
    const shapeItems = shapeStructs.map((d) => deps.structItemFromDef(d, []));

    items.push({
      kind: "mod",
      name: modName,
      items: freezeReadonlyArray([...usesSorted, ...shapeItems, ...declItems]),
    });
  }

  const rootAttrs = attrsByFile.get(entryFileName) ?? asReadonlyMap(new Map<string, readonly string[]>());
  items.push(
    ...rootModule.declarations.flatMap((decl) => {
      const declName =
        decl.kind === "typeAlias"
          ? decl.decl.name.text
          : decl.kind === "interface"
            ? ""
            : decl.decl.name?.text ?? "";
      return lowerDecl(decl, rootAttrs.get(declName) ?? []);
    })
  );

  return {
    items: freezeReadonlyArray(items),
    rootAttrs: asReadonlyMap(rootAttrs),
  };
}
