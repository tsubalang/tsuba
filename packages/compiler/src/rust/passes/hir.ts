import { asReadonlyMap, freezeReadonlyArray, type FileLowered, type HirDecl, type HirModule } from "./contracts.js";

export function buildHirModulesPass(
  loweredByFile: ReadonlyMap<string, FileLowered>
): ReadonlyMap<string, HirModule> {
  const out = new Map<string, HirModule>();

  for (const [fileName, lowered] of loweredByFile.entries()) {
    const decls: HirDecl[] = [
      ...lowered.typeAliases.map((x) => ({ kind: "typeAlias" as const, pos: x.pos, decl: x.decl })),
      ...lowered.interfaces.map((x) => ({ kind: "interface" as const, pos: x.pos, decl: x.decl })),
      ...lowered.classes.map((x) => ({ kind: "class" as const, pos: x.pos, decl: x.decl })),
      ...lowered.functions.map((x) => ({ kind: "function" as const, pos: x.pos, decl: x.decl })),
    ].sort((a, b) => a.pos - b.pos);

    out.set(
      fileName,
      Object.freeze({
        fileName: lowered.fileName,
        sourceFile: lowered.sourceFile,
        uses: lowered.uses,
        declarations: freezeReadonlyArray(decls.map((d) => Object.freeze({ ...d }))),
        annotations: lowered.annotations,
      })
    );
  }

  return asReadonlyMap(out);
}
