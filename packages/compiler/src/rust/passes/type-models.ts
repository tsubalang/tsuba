import type { HirModule } from "./contracts.js";

type TypeModelsPassDeps = {
  readonly onTypeAlias: (decl: Extract<HirModule["declarations"][number], { readonly kind: "typeAlias" }>["decl"]) => void;
  readonly onInterface: (decl: Extract<HirModule["declarations"][number], { readonly kind: "interface" }>["decl"]) => void;
};

export function collectTypeModelsPass(
  hirByFile: ReadonlyMap<string, HirModule>,
  deps: TypeModelsPassDeps
): void {
  for (const module of hirByFile.values()) {
    for (const decl of module.declarations) {
      if (decl.kind === "typeAlias") deps.onTypeAlias(decl.decl);
      if (decl.kind === "interface") deps.onInterface(decl.decl);
    }
  }
}
