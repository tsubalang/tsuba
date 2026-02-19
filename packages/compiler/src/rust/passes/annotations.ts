import ts from "typescript";

import {
  asReadonlyMap,
  freezeReadonlyArray,
  type HirModule,
} from "./contracts.js";

type AnnotationsPassDeps = {
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly unionKeyFromDecl: (decl: ts.TypeAliasDeclaration) => string;
  readonly hasUnionDef: (key: string) => boolean;
  readonly hasStructDef: (key: string) => boolean;
};

export function collectAnnotationsPass(
  hirByFile: ReadonlyMap<string, HirModule>,
  entryFileName: string,
  mainFn: ts.FunctionDeclaration,
  deps: AnnotationsPassDeps
): ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> {
  const attrsByFile = new Map<string, ReadonlyMap<string, readonly string[]>>();

  for (const [fileName, module] of hirByFile.entries()) {
    const declPosByName = new Map<string, number>();
    for (const decl of module.declarations) {
      if (decl.kind === "function") {
        const n = decl.decl.name?.text;
        if (n) declPosByName.set(n, decl.pos);
      }
      if (decl.kind === "class") {
        const n = decl.decl.name?.text;
        if (n) declPosByName.set(n, decl.pos);
      }
      if (decl.kind === "typeAlias") {
        const key = deps.unionKeyFromDecl(decl.decl);
        if (deps.hasUnionDef(key) || deps.hasStructDef(key)) {
          declPosByName.set(decl.decl.name.text, decl.pos);
        }
      }
    }
    if (fileName === entryFileName) {
      declPosByName.set("main", mainFn.pos);
    }

    const attrsByName = new Map<string, readonly string[]>();
    for (const a of module.annotations) {
      const declPos = declPosByName.get(a.target);
      if (declPos === undefined) {
        deps.failAt(a.node, "TSB3310", `annotate(...) target '${a.target}' was not found in this module.`);
      }
      if (a.pos <= declPos) {
        deps.failAt(a.node, "TSB3311", `annotate(${a.target}, ...) must appear after the declaration in v0.`);
      }
      const list = [...(attrsByName.get(a.target) ?? []), ...a.attrs];
      attrsByName.set(a.target, freezeReadonlyArray(list));
    }
    attrsByFile.set(fileName, asReadonlyMap(attrsByName));
  }

  return asReadonlyMap(attrsByFile);
}
