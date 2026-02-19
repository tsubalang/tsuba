import ts from "typescript";

import type { RustItem } from "../ir.js";
import {
  asReadonlyMap,
  freezeReadonlyArray,
  type FileLowered,
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
  loweredByFile: ReadonlyMap<string, FileLowered>,
  moduleNameByFile: ReadonlyMap<string, string>,
  attrsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  deps: DeclarationEmissionPassDeps<TCtx>
): DeclarationEmissionOutput {
  const items: RustItem[] = [];

  const rootLowered = loweredByFile.get(entryFileName);
  if (!rootLowered) deps.failAt(entrySourceFile, "TSB0001", "Internal error: entry file missing from lowered set.");

  items.push(...deps.sortUseItems(rootLowered.uses));

  const moduleFiles = [...moduleNameByFile.entries()].sort((a, b) => deps.compareText(a[0], b[0]));
  for (const [fileName, modName] of moduleFiles) {
    const lowered = loweredByFile.get(fileName);
    if (!lowered) continue;
    const fileAttrs = attrsByFile.get(fileName) ?? asReadonlyMap(new Map<string, readonly string[]>());
    const itemGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];

    for (const t0 of lowered.typeAliases) {
      itemGroups.push({
        pos: t0.pos,
        items: deps.lowerTypeAlias(ctx, t0.decl, fileAttrs.get(t0.decl.name.text) ?? []),
      });
    }
    for (const i0 of lowered.interfaces) {
      itemGroups.push({ pos: i0.pos, items: deps.lowerInterface(ctx, i0.decl) });
    }
    for (const c0 of lowered.classes) {
      itemGroups.push({
        pos: c0.pos,
        items: deps.lowerClass(ctx, c0.decl, fileAttrs.get(c0.decl.name?.text ?? "") ?? []),
      });
    }
    for (const f0 of lowered.functions) {
      itemGroups.push({
        pos: f0.pos,
        items: [deps.lowerFunction(ctx, f0.decl, fileAttrs.get(f0.decl.name?.text ?? "") ?? [])],
      });
    }
    itemGroups.sort((a, b) => a.pos - b.pos);
    const declItems = itemGroups.flatMap((g) => g.items);

    const usesSorted = deps.sortUseItems(lowered.uses);
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
  const rootGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];
  for (const t0 of rootLowered.typeAliases) {
    rootGroups.push({
      pos: t0.pos,
      items: deps.lowerTypeAlias(ctx, t0.decl, rootAttrs.get(t0.decl.name.text) ?? []),
    });
  }
  for (const i0 of rootLowered.interfaces) {
    rootGroups.push({ pos: i0.pos, items: deps.lowerInterface(ctx, i0.decl) });
  }
  for (const c0 of rootLowered.classes) {
    rootGroups.push({
      pos: c0.pos,
      items: deps.lowerClass(ctx, c0.decl, rootAttrs.get(c0.decl.name?.text ?? "") ?? []),
    });
  }
  for (const f0 of rootLowered.functions) {
    rootGroups.push({
      pos: f0.pos,
      items: [deps.lowerFunction(ctx, f0.decl, rootAttrs.get(f0.decl.name?.text ?? "") ?? [])],
    });
  }
  rootGroups.sort((a, b) => a.pos - b.pos);
  items.push(...rootGroups.flatMap((g) => g.items));

  return {
    items: freezeReadonlyArray(items),
    rootAttrs: asReadonlyMap(rootAttrs),
  };
}
