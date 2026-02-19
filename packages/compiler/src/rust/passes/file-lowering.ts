import { existsSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import type { RustItem } from "../ir.js";
import type { FileLowered } from "./contracts.js";

type CrateDepSpec = {
  readonly name: string;
  readonly package?: string;
  readonly features?: readonly string[];
} & ({ readonly version: string } | { readonly path: string });

type BindingsManifest = {
  readonly schema: number;
  readonly kind: "crate";
  readonly crate: {
    readonly name: string;
    readonly package?: string;
    readonly version?: string;
    readonly path?: string;
    readonly features?: readonly string[];
  };
  readonly modules: Record<string, string>;
};

type FileLoweringPassDeps = {
  readonly normalizePath: (path: string) => string;
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly isMarkerModuleSpecifier: (specifier: string) => boolean;
  readonly hasModifier: (
    node: ts.Node & { readonly modifiers?: readonly ts.ModifierLike[] },
    kind: ts.SyntaxKind
  ) => boolean;
  readonly tryParseAnnotateStatement: (
    statement: ts.Statement
  ) => { readonly target: string; readonly attrs: readonly string[] } | undefined;
  readonly isKernelImportIdentifier: (identifier: ts.Identifier) => boolean;
  readonly isKernelInitializer: (initializer: ts.Expression) => boolean;
  readonly resolveRelativeImport: (
    atNode: ts.Node,
    fromFileName: string,
    spec: string,
    userFilesByName: ReadonlyMap<string, ts.SourceFile>,
    moduleNameByFile: ReadonlyMap<string, string>
  ) => { readonly targetFile: string; readonly mod: string };
  readonly packageNameFromSpecifier: (specifier: string) => string;
  readonly findNodeModulesPackageRoot: (fromFileName: string, packageName: string) => string | undefined;
  readonly readBindingsManifest: (manifestPath: string, atNode: ts.Node) => BindingsManifest;
  readonly addUsedCrate: (atNode: ts.Node, dep: CrateDepSpec) => void;
  readonly splitRustPath: (path: string) => readonly string[];
  readonly spanFromNode: (node: ts.Node) => RustItem["span"];
};

export function collectFileLoweringsPass(
  userSourceFiles: readonly ts.SourceFile[],
  entryFileName: string,
  userFilesByName: ReadonlyMap<string, ts.SourceFile>,
  moduleNameByFile: ReadonlyMap<string, string>,
  deps: FileLoweringPassDeps
): ReadonlyMap<string, FileLowered> {
  const loweredByFile = new Map<string, FileLowered>();

  for (const f of userSourceFiles) {
    const fileName = deps.normalizePath(f.fileName);
    const uses: RustItem[] = [];
    const classes: { readonly pos: number; readonly decl: ts.ClassDeclaration }[] = [];
    const functions: { readonly pos: number; readonly decl: ts.FunctionDeclaration }[] = [];
    const typeAliases: { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[] = [];
    const interfaces: { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[] = [];
    const annotations: { pos: number; node: ts.Statement; target: string; attrs: string[] }[] = [];

    for (const st of f.statements) {
      if (ts.isImportDeclaration(st)) {
        const specNode = st.moduleSpecifier;
        if (!ts.isStringLiteral(specNode)) {
          deps.failAt(specNode, "TSB3205", "Import module specifier must be a string literal in v0.");
        }
        const spec = specNode.text;

        if (deps.isMarkerModuleSpecifier(spec)) continue;

        const clause = st.importClause;
        if (!clause) {
          deps.failAt(st, "TSB3206", "Side-effect-only imports are not supported in v0.");
        }
        if (clause.name) {
          deps.failAt(clause.name, "TSB3207", "Default imports are not supported in v0.");
        }

        const bindings = clause.namedBindings;
        if (!bindings) {
          deps.failAt(st, "TSB3208", "Import must have named bindings in v0.");
        }

        if (ts.isNamespaceImport(bindings)) {
          deps.failAt(bindings, "TSB3209", "Namespace imports (import * as x) are not supported in v0.");
        }
        if (!ts.isNamedImports(bindings)) {
          deps.failAt(bindings, "TSB3210", "Unsupported import binding form in v0.");
        }

        if (spec.startsWith(".")) {
          const resolved = deps.resolveRelativeImport(st, f.fileName, spec, userFilesByName, moduleNameByFile);
          for (const el of bindings.elements) {
            if (deps.isKernelImportIdentifier(el.name)) continue;
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
              span: deps.spanFromNode(el),
              path: { segments: ["crate", resolved.mod, exported] },
              alias: local !== exported ? local : undefined,
            });
          }
        } else {
          const pkgName = deps.packageNameFromSpecifier(spec);
          const pkgRoot = deps.findNodeModulesPackageRoot(f.fileName, pkgName);
          if (!pkgRoot) {
            deps.failAt(specNode, "TSB3211", `Could not resolve package '${pkgName}' for import ${JSON.stringify(spec)}.`);
          }
          const manifestPath = join(pkgRoot, "tsuba.bindings.json");
          if (!existsSync(manifestPath)) {
            deps.failAt(
              specNode,
              "TSB3212",
              `No tsuba.bindings.json found for package '${pkgName}' (needed for import ${JSON.stringify(spec)}).`
            );
          }
          const manifest = deps.readBindingsManifest(manifestPath, specNode);
          const rustModule = manifest.modules[spec];
          if (!rustModule) {
            deps.failAt(
              specNode,
              "TSB3213",
              `No module mapping for ${JSON.stringify(spec)} in ${manifestPath}.`
            );
          }
          const depBase = {
            name: manifest.crate.name,
            package: manifest.crate.package,
            features: manifest.crate.features,
          };
          if (manifest.crate.path) {
            deps.addUsedCrate(specNode, { ...depBase, path: manifest.crate.path });
          } else {
            deps.addUsedCrate(specNode, { ...depBase, version: manifest.crate.version! });
          }

          const baseSegs = deps.splitRustPath(rustModule);
          for (const el of bindings.elements) {
            if (deps.isKernelImportIdentifier(el.name)) continue;
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
              span: deps.spanFromNode(el),
              path: { segments: [...baseSegs, exported] },
              alias: local !== exported ? local : undefined,
            });
          }
        }
        continue;
      }

      if (ts.isExportDeclaration(st)) {
        const isNoopExportMarker =
          !st.moduleSpecifier &&
          !!st.exportClause &&
          ts.isNamedExports(st.exportClause) &&
          st.exportClause.elements.length === 0;

        if (isNoopExportMarker) continue;

        deps.failAt(
          st,
          "TSB3214",
          "Export declarations (re-exports/barrel exports) are not supported in v0. Import directly from source modules."
        );
      }

      if (ts.isEmptyStatement(st)) {
        continue;
      }

      if (ts.isTypeAliasDeclaration(st)) {
        typeAliases.push({ pos: st.pos, decl: st });
        continue;
      }

      if (ts.isInterfaceDeclaration(st)) {
        interfaces.push({ pos: st.pos, decl: st });
        continue;
      }

      const ann = deps.tryParseAnnotateStatement(st);
      if (ann) {
        annotations.push({ pos: st.pos, node: st, target: ann.target, attrs: [...ann.attrs] });
        continue;
      }

      if (ts.isVariableStatement(st)) {
        if (deps.hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;

        const declList = st.declarationList;
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) deps.failAt(st, "TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);

        const allKernelDecls = declList.declarations.every((d) => {
          if (!ts.isIdentifier(d.name)) return false;
          if (!d.initializer) return false;
          return deps.isKernelInitializer(d.initializer);
        });

        if (allKernelDecls) continue;

        deps.failAt(st, "TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);
      }

      if (ts.isFunctionDeclaration(st)) {
        if (!st.body) continue;
        if (!st.name) deps.failAt(st, "TSB3000", "Unnamed functions are not supported in v0.");
        if (st.name.text === "main" && fileName === entryFileName) continue;

        functions.push({ pos: st.pos, decl: st });
        continue;
      }

      if (ts.isClassDeclaration(st)) {
        if (!st.name) deps.failAt(st, "TSB4000", "Anonymous classes are not supported in v0.");
        classes.push({ pos: st.pos, decl: st });
        continue;
      }

      deps.failAt(st, "TSB3102", `Unsupported top-level statement: ${st.getText()}`);
    }

    loweredByFile.set(fileName, {
      fileName,
      sourceFile: f,
      uses,
      classes,
      functions,
      typeAliases,
      interfaces,
      annotations,
    });
  }

  return loweredByFile;
}
