import type { FileLowered } from "./contracts.js";

type TypeModelsPassDeps = {
  readonly onTypeAlias: (decl: FileLowered["typeAliases"][number]["decl"]) => void;
  readonly onInterface: (decl: FileLowered["interfaces"][number]["decl"]) => void;
};

export function collectTypeModelsPass(
  loweredByFile: ReadonlyMap<string, FileLowered>,
  deps: TypeModelsPassDeps
): void {
  for (const lowered of loweredByFile.values()) {
    for (const typeAlias of lowered.typeAliases) {
      deps.onTypeAlias(typeAlias.decl);
    }
    for (const i0 of lowered.interfaces) {
      deps.onInterface(i0.decl);
    }
  }
}
