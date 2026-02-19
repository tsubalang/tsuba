import ts from "typescript";

import {
  asReadonlyMap,
  freezeReadonlyArray,
  type FileLowered,
} from "./contracts.js";

type AnnotationsPassDeps = {
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly unionKeyFromDecl: (decl: ts.TypeAliasDeclaration) => string;
  readonly hasUnionDef: (key: string) => boolean;
  readonly hasStructDef: (key: string) => boolean;
};

export function collectAnnotationsPass(
  loweredByFile: ReadonlyMap<string, FileLowered>,
  entryFileName: string,
  mainFn: ts.FunctionDeclaration,
  deps: AnnotationsPassDeps
): ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> {
  const attrsByFile = new Map<string, ReadonlyMap<string, readonly string[]>>();

  for (const [fileName, lowered] of loweredByFile.entries()) {
    const declPosByName = new Map<string, number>();
    for (const f0 of lowered.functions) {
      const n = f0.decl.name?.text;
      if (n) declPosByName.set(n, f0.pos);
    }
    for (const c0 of lowered.classes) {
      const n = c0.decl.name?.text;
      if (n) declPosByName.set(n, c0.pos);
    }
    for (const t0 of lowered.typeAliases) {
      const key = deps.unionKeyFromDecl(t0.decl);
      if (deps.hasUnionDef(key) || deps.hasStructDef(key)) {
        declPosByName.set(t0.decl.name.text, t0.pos);
      }
    }
    if (fileName === entryFileName) {
      declPosByName.set("main", mainFn.pos);
    }

    const attrsByName = new Map<string, readonly string[]>();
    for (const a of lowered.annotations) {
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
