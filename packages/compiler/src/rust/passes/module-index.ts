import { dirname, resolve } from "node:path";

import ts from "typescript";

import { asReadonlyMap, type UserModuleIndex } from "./contracts.js";

type ModuleIndexPassDeps = {
  readonly normalizePath: (path: string) => string;
  readonly rustModuleNameFromFileName: (fileName: string) => string;
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
};

export function createUserModuleIndexPass(
  userSourceFiles: readonly ts.SourceFile[],
  entryFileName: string,
  deps: ModuleIndexPassDeps
): UserModuleIndex {
  const userFilesByName = new Map<string, ts.SourceFile>();
  for (const f of userSourceFiles) userFilesByName.set(deps.normalizePath(f.fileName), f);

  const moduleNameByFile = new Map<string, string>();
  const fileByModuleName = new Map<string, ts.SourceFile>();
  for (const f of userSourceFiles) {
    const fileName = deps.normalizePath(f.fileName);
    if (fileName === entryFileName) continue;
    const modName = deps.rustModuleNameFromFileName(f.fileName);
    const prev = fileByModuleName.get(modName);
    if (prev) {
      const prevFileName = deps.normalizePath(prev.fileName);
      deps.failAt(
        f,
        "TSB3200",
        `Two files map to the same Rust module '${modName}':\n  - ${prevFileName}\n  - ${fileName}\nRename one of the files to avoid a module collision.`
      );
    }
    fileByModuleName.set(modName, f);
    moduleNameByFile.set(fileName, modName);
  }

  return Object.freeze({
    userFilesByName: asReadonlyMap(userFilesByName),
    moduleNameByFile: asReadonlyMap(moduleNameByFile),
  });
}

export function resolveRelativeImportPass(
  atNode: ts.Node,
  fromFileName: string,
  spec: string,
  userFilesByName: ReadonlyMap<string, ts.SourceFile>,
  moduleNameByFile: ReadonlyMap<string, string>,
  deps: ModuleIndexPassDeps
): { readonly targetFile: string; readonly mod: string } {
  if (!spec.startsWith(".")) {
    deps.failAt(atNode, "TSB3201", `Only relative imports are supported in v0 (got ${JSON.stringify(spec)}).`);
  }
  let rewritten = spec;
  if (rewritten.endsWith(".js")) rewritten = `${rewritten.slice(0, -3)}.ts`;
  if (!rewritten.endsWith(".ts")) {
    deps.failAt(
      atNode,
      "TSB3202",
      `Import specifier must end with '.js' (source) in v0 (got ${JSON.stringify(spec)}).`
    );
  }

  const abs = deps.normalizePath(resolve(dirname(fromFileName), rewritten));
  const target = userFilesByName.get(abs);
  if (!target) {
    deps.failAt(atNode, "TSB3203", `Import target not found in the project: ${JSON.stringify(spec)} -> ${abs}`);
  }
  const mod = moduleNameByFile.get(abs);
  if (!mod) {
    deps.failAt(atNode, "TSB3204", `Importing the entry module is not supported in v0 (got ${JSON.stringify(spec)}).`);
  }
  return { targetFile: abs, mod };
}
