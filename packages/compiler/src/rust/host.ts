import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type {
  RustExpr,
  RustGenericParam,
  RustItem,
  RustMatchArm,
  RustParam,
  RustProgram,
  RustStmt,
  RustType,
  RustVisibility,
  Span,
} from "./ir.js";
import { assertCompilerDiagnosticCode } from "./diagnostics.js";
import { identExpr, pathExpr, pathType, unitExpr, unitType } from "./ir.js";
import { runBootstrapPass } from "./passes/bootstrap.js";
import { createUserModuleIndexPass, resolveRelativeImportPass } from "./passes/module-index.js";
import { collectFileLoweringsPass } from "./passes/file-lowering.js";
import { buildHirModulesPass } from "./passes/hir.js";
import { collectTypeModelsPass } from "./passes/type-models.js";
import { collectAnnotationsPass } from "./passes/annotations.js";
import { emitModuleAndRootDeclarationsPass } from "./passes/declaration-emission.js";
import { emitMainAndRootShapesPass } from "./passes/main-emission.js";
import { renderCudaRuntimeModule } from "./cuda-runtime.js";
import {
  collectKernelDecls,
  kernelDeclForIdentifier as lookupKernelDeclForIdentifier,
  type KernelDecl,
} from "./kernel-dialect.js";
import { writeRustProgram } from "./write.js";
import {
  isMutMarkerType,
  lowerTypeParameters as lowerTypeParametersFromLowering,
  methodReceiverFromThisParam,
  typeNodeToRust as typeNodeToRustFromLowering,
  unwrapPromiseInnerType as unwrapPromiseInnerTypeFromLowering,
} from "./lowering/type-lowering.js";
import { tryParseAnnotateStatement as tryParseAnnotateStatementFromLowering } from "./lowering/annotations.js";

export type { KernelDecl } from "./kernel-dialect.js";

export type CompileIssue = {
  readonly code: string;
  readonly message: string;
};

export class CompileError extends Error {
  readonly code: string;
  readonly span?: Span;

  constructor(code: string, message: string, span?: Span) {
    assertCompilerDiagnosticCode(code);
    super(message);
    this.code = code;
    this.span = span;
    this.name = "CompileError";
  }
}

export type CompileHostOptions = {
  readonly entryFile: string;
  readonly runtimeKind?: "none" | "tokio";
};

export type CrateDep = {
  readonly name: string;
  readonly package?: string;
  readonly features?: readonly string[];
} & ({ readonly version: string } | { readonly path: string });

export type CompileHostOutput = {
  readonly mainRs: string;
  readonly kernels: readonly KernelDecl[];
  readonly crates: readonly CrateDep[];
};

type UnionVariantDef = {
  readonly tag: string;
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly type: RustType }[];
};

type UnionDef = {
  readonly key: string;
  readonly name: string;
  readonly discriminant: string;
  readonly variants: readonly UnionVariantDef[];
};

type StructDef = {
  readonly key: string;
  readonly name: string;
  readonly span: Span;
  readonly vis: "pub" | "private";
  readonly fields: readonly { readonly name: string; readonly type: RustType }[];
};

type TraitMethodDef = {
  readonly name: string;
  readonly span: Span;
  readonly receiver: { readonly mut: boolean; readonly lifetime?: string };
  readonly typeParams: readonly RustGenericParam[];
  readonly params: readonly RustParam[];
  readonly ret: RustType;
};

type TraitDef = {
  readonly key: string;
  readonly name: string;
  readonly span: Span;
  readonly vis: "pub" | "private";
  readonly typeParams: readonly RustGenericParam[];
  readonly superTraits: readonly RustType[];
  readonly methods: readonly TraitMethodDef[];
};

type EmitCtx = {
  readonly checker: ts.TypeChecker;
  readonly thisName?: string;
  readonly inAsync?: boolean;
  readonly unions: Map<string, UnionDef>;
  readonly structs: Map<string, StructDef>;
  readonly traitsByKey: Map<string, TraitDef>;
  readonly traitsByName: Map<string, TraitDef[]>;
  readonly shapeStructsByKey: Map<string, StructDef>;
  readonly shapeStructsByFile: Map<string, StructDef[]>;
  readonly kernelDeclBySymbol: Map<ts.Symbol, KernelDecl>;
  readonly gpuRuntime: { used: boolean };
  readonly generatedNameCounters: { switchTemp: number };
  readonly fieldBindings?: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

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

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function syntheticSpanForFile(fileName: string): Span {
  return {
    fileName: mapSpanFileName(fileName),
    start: 0,
    end: 0,
  };
}

function createSpanFileNameMapper(entryFile: string): (raw: string) => string {
  const entryDir = normalizePath(resolve(dirname(entryFile)));
  return (raw: string): string => {
    const abs = normalizePath(resolve(raw));
    const rel = normalizePath(
      abs === entryDir ? "." : abs.startsWith(`${entryDir}/`) ? abs.slice(entryDir.length + 1) : abs
    );
    return rel.length === 0 ? "." : rel;
  };
}

let activeSpanFileNameMapper: ((raw: string) => string) | undefined;

function withSpanFileNameMapper<T>(mapper: (raw: string) => string, fn: () => T): T {
  const prev = activeSpanFileNameMapper;
  activeSpanFileNameMapper = mapper;
  try {
    return fn();
  } finally {
    activeSpanFileNameMapper = prev;
  }
}

function mapSpanFileName(raw: string): string {
  const normalized = normalizePath(raw);
  return activeSpanFileNameMapper ? activeSpanFileNameMapper(normalized) : normalized;
}

function rustIdentFromStem(stem: string): string {
  const raw = stem
    .replaceAll(/[^A-Za-z0-9_]/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  const lower = raw.length === 0 ? "mod" : raw.toLowerCase();
  return /^[0-9]/.test(lower) ? `_${lower}` : lower;
}

function rustModuleNameFromFileName(fileName: string): string {
  const b = basename(fileName);
  const stem = b.replaceAll(/\.[^.]+$/g, "");
  return rustIdentFromStem(stem);
}

function rustTypeNameFromTag(tag: string): string {
  const raw = tag
    .replaceAll(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
  const base = raw.length === 0 ? "Variant" : raw;
  return /^[0-9]/.test(base) ? `V${base}` : base;
}

function splitRustPath(path: string): readonly string[] {
  return path.split("::").filter((s) => s.length > 0);
}

function unionKeyFromDecl(decl: ts.TypeAliasDeclaration): string {
  return `${normalizePath(decl.getSourceFile().fileName)}::${decl.name.text}`;
}

function traitKeyFromDecl(decl: ts.InterfaceDeclaration): string {
  return `${normalizePath(decl.getSourceFile().fileName)}::${decl.name.text}`;
}

function unionKeyFromType(type: ts.Type): string | undefined {
  const alias = (type as unknown as { readonly aliasSymbol?: ts.Symbol }).aliasSymbol;
  if (!alias) return undefined;
  for (const d of alias.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(d)) return unionKeyFromDecl(d);
  }
  return undefined;
}

function unionDefFromType(ctx: EmitCtx, type: ts.Type): UnionDef | undefined {
  const key = unionKeyFromType(type);
  return key ? ctx.unions.get(key) : undefined;
}

function unionDefFromIdentifier(ctx: EmitCtx, ident: ts.Identifier): UnionDef | undefined {
  const direct = unionDefFromType(ctx, ctx.checker.getTypeAtLocation(ident));
  if (direct) return direct;

  const symbol = ctx.checker.getSymbolAtLocation(ident);
  for (const decl of symbol?.declarations ?? []) {
    const maybeTypeNode = (() => {
      if (
        ts.isVariableDeclaration(decl) ||
        ts.isParameter(decl) ||
        ts.isPropertyDeclaration(decl) ||
        ts.isPropertySignature(decl)
      ) {
        return decl.type;
      }
      return undefined;
    })();
    if (!maybeTypeNode) continue;
    const declared = unionDefFromType(ctx, ctx.checker.getTypeFromTypeNode(maybeTypeNode));
    if (declared) return declared;
  }

  return undefined;
}

function expressionToSegments(expr: ts.Expression): readonly string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expressionToSegments(expr.expression);
    if (!left) return undefined;
    return [...left, expr.name.text];
  }
  return undefined;
}

function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function anonStructName(key: string): string {
  return `__Anon_${fnv1a32(key).toString(16).padStart(8, "0")}`;
}

const markerModuleSpecifiers = new Set<string>([
  "@tsuba/core/lang.js",
  "@tsuba/core/types.js",
  "@tsuba/std/prelude.js",
  "@tsuba/std/macros.js",
  "@tsuba/gpu/lang.js",
  "@tsuba/gpu/types.js",
]);

function isMarkerModuleSpecifier(spec: string): boolean {
  return markerModuleSpecifiers.has(spec);
}

function packageNameFromSpecifier(spec: string): string {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  const idx = spec.indexOf("/");
  return idx === -1 ? spec : spec.slice(0, idx);
}

function findNodeModulesPackageRoot(fromFileName: string, packageName: string): string | undefined {
  const packagePath = join("node_modules", ...packageName.split("/"));
  let cur = resolve(dirname(fromFileName));
  while (true) {
    const candidate = join(cur, packagePath);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function readBindingsManifest(path: string, specNode: ts.Node): BindingsManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch (e) {
    failAt(specNode, "TSB3220", `Failed to read ${path}: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    failAt(specNode, "TSB3221", `${path} must be a JSON object.`);
  }
  let m = parsed as Partial<BindingsManifest>;
  if (m.schema !== 1) {
    failAt(specNode, "TSB3222", `${path}: unsupported schema (expected 1).`);
  }
  if (m.kind !== "crate") {
    failAt(specNode, "TSB3223", `${path}: unsupported kind (expected "crate").`);
  }
  const crate = m.crate;
  if (!crate || typeof crate.name !== "string") {
    failAt(specNode, "TSB3224", `${path}: missing crate.name.`);
  }
  if (crate.package !== undefined && typeof crate.package !== "string") {
    failAt(specNode, "TSB3224", `${path}: crate.package must be a string when present.`);
  }
  const hasVersion = typeof crate.version === "string";
  const hasPath = typeof crate.path === "string";
  if (hasVersion && hasPath) {
    failAt(specNode, "TSB3228", `${path}: crate must specify either version or path, not both.`);
  }
  if (!hasVersion && !hasPath) {
    failAt(specNode, "TSB3224", `${path}: crate must specify either version or path.`);
  }
  if (hasPath) {
    const abs = normalizePath(resolve(dirname(path), crate.path!));
    m = { ...m, crate: { ...crate, path: abs } };
  }
  const features = (m.crate ?? crate).features;
  if (features !== undefined) {
    if (!Array.isArray(features) || !features.every((x) => typeof x === "string")) {
      failAt(specNode, "TSB3227", `${path}: crate.features must be an array of strings when present.`);
    }
  }
  if (!m.modules || typeof m.modules !== "object") {
    failAt(specNode, "TSB3225", `${path}: missing modules mapping.`);
  }
  return m as BindingsManifest;
}

function spanFromNode(node: ts.Node): Span {
  const sf = node.getSourceFile();
  return {
    fileName: mapSpanFileName(sf.fileName),
    start: node.getStart(sf, false),
    end: node.getEnd(),
  };
}

function failAt(node: ts.Node, code: string, message: string): never {
  assertCompilerDiagnosticCode(code);
  throw new CompileError(code, message, spanFromNode(node));
}

function isFromTsubaCoreLang(ctx: EmitCtx, ident: ts.Identifier): boolean {
  const sym0 = ctx.checker.getSymbolAtLocation(ident);
  const sym =
    sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
  if (!sym) return false;
  for (const decl of sym.declarations ?? []) {
    const file = normalizePath(decl.getSourceFile().fileName);
    if (file.includes("/@tsuba/core/") && file.includes("/lang.")) return true;
    if (file.includes("/packages/core/") && file.includes("/dist/lang.d.ts")) return true;
  }
  return false;
}

function isFromTsubaStdPrelude(ctx: EmitCtx, ident: ts.Identifier): boolean {
  const sym0 = ctx.checker.getSymbolAtLocation(ident);
  const sym =
    sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
  if (!sym) return false;
  for (const decl of sym.declarations ?? []) {
    const file = normalizePath(decl.getSourceFile().fileName);
    if (file.includes("/@tsuba/std/") && file.includes("/prelude.")) return true;
    if (file.includes("/packages/std/") && file.includes("/dist/prelude.d.ts")) return true;
  }
  return false;
}

function isBottomMacroMarker(name: string): name is "panic" | "todo" | "unreachable" {
  return name === "panic" || name === "todo" || name === "unreachable";
}

function isFromTsubaGpuLang(ctx: EmitCtx, ident: ts.Identifier): boolean {
  const sym0 = ctx.checker.getSymbolAtLocation(ident);
  const sym =
    sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
  if (!sym) return false;
  for (const decl of sym.declarations ?? []) {
    const file = normalizePath(decl.getSourceFile().fileName);
    if (file.includes("/@tsuba/gpu/") && file.includes("/lang.")) return true;
    if (file.includes("/packages/gpu/") && file.includes("/dist/lang.d.ts")) return true;
  }
  return false;
}

function isClassValue(ctx: EmitCtx, ident: ts.Identifier): boolean {
  const sym0 = ctx.checker.getSymbolAtLocation(ident);
  const sym =
    sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
  if (!sym) return false;
  return (sym.declarations ?? []).some(
    (d) =>
      ts.isClassDeclaration(d) ||
      ts.isClassExpression(d) ||
      ts.isClassLike(d) ||
      (ts.isVariableDeclaration(d) &&
        d.initializer !== undefined &&
        ts.isClassExpression(d.initializer))
  );
}

function kernelDeclForIdentifier(ctx: EmitCtx, ident: ts.Identifier): KernelDecl | undefined {
  return lookupKernelDeclForIdentifier(ctx.checker, ctx.kernelDeclBySymbol, ident);
}

function fail(code: string, message: string, span?: Span): never {
  assertCompilerDiagnosticCode(code);
  throw new CompileError(code, message, span);
}

function getExportedMain(sf: ts.SourceFile): ts.FunctionDeclaration {
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st)) continue;
    if (st.name?.text !== "main") continue;
    const hasExport = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!hasExport) continue;
    if (!st.body) failAt(st, "TSB1001", "export function main must have a body.");
    if (st.parameters.length !== 0) failAt(st, "TSB1002", "main() parameters are not supported in v0.");
    return st;
  }
  failAt(sf, "TSB1000", "Entry file must export function main().");
}

function isInNodeModules(fileName: string): boolean {
  return normalizePath(fileName).includes("/node_modules/");
}

function hasModifier(
  node: ts.Node & { readonly modifiers?: readonly ts.ModifierLike[] },
  kind: ts.SyntaxKind
): boolean {
  return node.modifiers?.some((m: ts.ModifierLike) => m.kind === kind) ?? false;
}

function createEmitCtx(checker: ts.TypeChecker): EmitCtx {
  return {
    checker,
    unions: new Map<string, UnionDef>(),
    structs: new Map<string, StructDef>(),
    traitsByKey: new Map<string, TraitDef>(),
    traitsByName: new Map<string, TraitDef[]>(),
    shapeStructsByKey: new Map<string, StructDef>(),
    shapeStructsByFile: new Map<string, StructDef[]>(),
    kernelDeclBySymbol: new Map<ts.Symbol, KernelDecl>(),
    gpuRuntime: { used: false },
    generatedNameCounters: { switchTemp: 0 },
  };
}

function normalizeCrateDep(dep: CrateDep): CrateDep {
  const features = (dep.features ?? []).filter((x): x is string => typeof x === "string");
  const unique = [...new Set(features)].sort((a, b) => compareText(a, b));
  const base = dep.package ? { name: dep.name, package: dep.package } : { name: dep.name };
  if ("version" in dep) {
    return unique.length === 0
      ? { ...base, version: dep.version }
      : { ...base, version: dep.version, features: unique };
  }
  return unique.length === 0 ? { ...base, path: dep.path } : { ...base, path: dep.path, features: unique };
}

function addUsedCrate(usedCratesByName: Map<string, CrateDep>, node: ts.Node, dep: CrateDep): void {
  const prev = usedCratesByName.get(dep.name);
  if (!prev) {
    usedCratesByName.set(dep.name, normalizeCrateDep(dep));
    return;
  }

  const prevPkg = prev.package ?? prev.name;
  const depPkg = dep.package ?? dep.name;
  if (prevPkg !== depPkg) {
    failAt(node, "TSB3226", `Conflicting cargo package names for '${dep.name}': '${prevPkg}' vs '${depPkg}'.`);
  }
  if ("version" in prev && "version" in dep && prev.version !== dep.version) {
    failAt(
      node,
      "TSB3226",
      `Conflicting crate versions for '${dep.name}': '${prev.version}' vs '${dep.version}'.`
    );
  }
  if ("path" in prev && "path" in dep && prev.path !== dep.path) {
    failAt(node, "TSB3226", `Conflicting crate paths for '${dep.name}': '${prev.path}' vs '${dep.path}'.`);
  }
  if ("version" in prev !== "version" in dep) {
    const left = "version" in prev ? `version '${prev.version}'` : `path '${prev.path}'`;
    const right = "version" in dep ? `version '${dep.version}'` : `path '${dep.path}'`;
    failAt(node, "TSB3226", `Conflicting crate sources for '${dep.name}': ${left} vs ${right}.`);
  }

  const mergedFeatures = new Set<string>([...(prev.features ?? []), ...(dep.features ?? [])]);
  const features = [...mergedFeatures].sort((a, b) => compareText(a, b));
  const base = dep.package ? { name: dep.name, package: dep.package } : { name: dep.name };
  if ("version" in dep) {
    usedCratesByName.set(
      dep.name,
      features.length === 0 ? { ...base, version: dep.version } : { ...base, version: dep.version, features }
    );
  } else {
    usedCratesByName.set(
      dep.name,
      features.length === 0 ? { ...base, path: dep.path } : { ...base, path: dep.path, features }
    );
  }
}

function collectSortedKernelDecls(
  ctx: EmitCtx,
  userSourceFiles: readonly ts.SourceFile[]
): readonly KernelDecl[] {
  const seenKernelNames = new Set<string>();
  return userSourceFiles
    .flatMap((f) =>
      collectKernelDecls(ctx.checker, ctx.kernelDeclBySymbol, f, seenKernelNames, {
        failAt,
        isFromTsubaGpuLang: (identifier) => isFromTsubaGpuLang(ctx, identifier),
      })
    )
    .sort((a, b) => compareText(a.name, b.name));
}

function sortUseItems(uses: readonly RustItem[]): RustItem[] {
  return [...uses].sort((a, b) => {
    if (a.kind !== "use" || b.kind !== "use") return 0;
    const pa = a.path.segments.join("::");
    const pb = b.path.segments.join("::");
    if (pa !== pb) return compareText(pa, pb);
    const aa = a.alias ?? "";
    const ab = b.alias ?? "";
    return compareText(aa, ab);
  });
}

function tryParseAnnotateStatement(
  ctx: EmitCtx,
  st: ts.Statement
): { readonly target: string; readonly attrs: readonly string[] } | undefined {
  return tryParseAnnotateStatementFromLowering(
    {
      failAt,
      isFromTsubaCoreLang: (ident) => isFromTsubaCoreLang(ctx, ident),
      isAttrMacroType: (node) => isAttrMacroType(ctx.checker, node),
      isDeriveMacroType: (node) => isDeriveMacroType(ctx.checker, node),
    },
    st
  );
}

function typeNodeToRust(typeNode: ts.TypeNode | undefined): RustType {
  return typeNodeToRustFromLowering(typeNode, { failAt });
}

function unwrapPromiseInnerType(
  ownerNode: ts.Node,
  ownerLabel: string,
  typeNode: ts.TypeNode | undefined,
  code: string
): ts.TypeNode {
  return unwrapPromiseInnerTypeFromLowering(ownerNode, ownerLabel, typeNode, code, { failAt });
}

function lowerTypeParameters(
  checker: ts.TypeChecker,
  ownerNode: ts.Node,
  ownerLabel: string,
  params: readonly ts.TypeParameterDeclaration[] | undefined,
  code: string
): readonly RustGenericParam[] {
  return lowerTypeParametersFromLowering(checker, ownerNode, ownerLabel, params, code, { failAt });
}

function rustTypeEq(a: RustType, b: RustType): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "unit":
      return true;
    case "ref":
      return b.kind === "ref" && a.mut === b.mut && a.lifetime === b.lifetime && rustTypeEq(a.inner, b.inner);
    case "slice":
      return b.kind === "slice" && rustTypeEq(a.inner, b.inner);
    case "array":
      return b.kind === "array" && a.len === b.len && rustTypeEq(a.inner, b.inner);
    case "tuple":
      return (
        b.kind === "tuple" &&
        a.elems.length === b.elems.length &&
        a.elems.every((t, i) => rustTypeEq(t, b.elems[i]!))
      );
    case "path":
      return (
        b.kind === "path" &&
        a.path.segments.length === b.path.segments.length &&
        a.path.segments.every((s, i) => s === b.path.segments[i]) &&
        a.args.length === b.args.length &&
        a.args.every((t, i) => rustTypeEq(t, b.args[i]!))
      );
  }
}

function substituteRustType(type: RustType, subst: ReadonlyMap<string, RustType>): RustType {
  switch (type.kind) {
    case "unit":
      return type;
    case "ref":
      return { ...type, inner: substituteRustType(type.inner, subst) };
    case "slice":
      return { ...type, inner: substituteRustType(type.inner, subst) };
    case "array":
      return { ...type, inner: substituteRustType(type.inner, subst) };
    case "tuple":
      return { ...type, elems: type.elems.map((e) => substituteRustType(e, subst)) };
    case "path": {
      if (type.path.segments.length === 1 && type.args.length === 0) {
        const replacement = subst.get(type.path.segments[0]!);
        if (replacement) return replacement;
      }
      return { ...type, args: type.args.map((a) => substituteRustType(a, subst)) };
    }
  }
}

function lowerExprWithTypeArgsToRustType(
  ownerLabel: string,
  exprWithTypeArgs: ts.ExpressionWithTypeArguments,
  code: string
): RustType {
  const segments = expressionToSegments(exprWithTypeArgs.expression);
  if (!segments) {
    failAt(exprWithTypeArgs.expression, code, `${ownerLabel}: unsupported qualified name in v0.`);
  }
  const args = (exprWithTypeArgs.typeArguments ?? []).map((a) => typeNodeToRust(a));
  return pathType(segments, args);
}

function hasTypeBrand(checker: ts.TypeChecker, node: ts.Expression, brand: string): boolean {
  const ty = checker.getTypeAtLocation(node);
  return ty.getProperty(brand) !== undefined;
}

function isMacroType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return hasTypeBrand(checker, node, "__tsuba_macro");
}

function isAttrMacroType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return hasTypeBrand(checker, node, "__tsuba_attr_macro");
}

function isDeriveMacroType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  return hasTypeBrand(checker, node, "__tsuba_derive");
}

function isFromTsubaCoreTypesSymbol(sym: ts.Symbol): boolean {
  for (const decl of sym.declarations ?? []) {
    const file = normalizePath(decl.getSourceFile().fileName);
    const isCorePackage =
      file.includes("/node_modules/@tsuba/core/") || file.includes("/packages/core/");
    if (isCorePackage && file.includes("/types.")) return true;
  }
  return false;
}

function isTupleType(ty: ts.Type | undefined): boolean {
  if (!ty) return false;
  if ((ty.flags & ts.TypeFlags.Object) === 0) return false;
  const obj = ty as ts.ObjectType;
  if ((obj.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  // Tuple types are often TypeReferences whose target carries the Tuple flag.
  if ((obj.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const ref = obj as ts.TypeReference;
    const target = ref.target as ts.ObjectType | undefined;
    if (target && (target.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  }
  return false;
}

function isArrayNType(ty: ts.Type | undefined): boolean {
  if (!ty) return false;
  const aliasSym = (ty as any).aliasSymbol as ts.Symbol | undefined;
  if (aliasSym?.name === "ArrayN" && isFromTsubaCoreTypesSymbol(aliasSym)) return true;
  const lenProp = ty.getProperty("__tsuba_array_len");
  if (lenProp && isFromTsubaCoreTypesSymbol(lenProp)) return true;
  return false;
}

type DefaultedParam = {
  readonly name: string;
  readonly type: RustType;
  readonly initializer: ts.Expression;
  readonly span: Span;
};

function optionType(inner: RustType): RustType {
  return pathType(["Option"], [inner]);
}

function someExpr(expr: RustExpr): RustExpr {
  return { kind: "call", callee: identExpr("Some"), args: [expr] };
}

function noneExpr(): RustExpr {
  return pathExpr(["None"]);
}

function lowerDefaultParamPrelude(ctx: EmitCtx, defaults: readonly DefaultedParam[]): readonly RustStmt[] {
  const prelude: RustStmt[] = [];
  for (const def of defaults) {
    prelude.push({
      kind: "let",
      span: def.span,
      pattern: { kind: "ident", name: def.name },
      mut: false,
      type: def.type,
      init: {
        kind: "call",
        callee: { kind: "field", expr: identExpr(def.name), name: "unwrap_or" },
        args: [lowerExpr(ctx, def.initializer)],
      },
    });
  }
  return prelude;
}

function lowerArrowBodyToExpr(
  ctx: EmitCtx,
  body: ts.ConciseBody,
  defaultPrelude: readonly RustStmt[]
): RustExpr {
  if (!ts.isBlock(body)) {
    const tail = lowerExpr(ctx, body);
    if (defaultPrelude.length === 0) return tail;
    return { kind: "block", stmts: [...defaultPrelude], tail };
  }

  const stmts: RustStmt[] = [...defaultPrelude];
  const bodyStmts = [...body.statements];
  if (bodyStmts.length === 0) {
    return { kind: "block", stmts, tail: unitExpr() };
  }

  for (let i = 0; i < bodyStmts.length; i++) {
    const st = bodyStmts[i]!;
    const isLast = i === bodyStmts.length - 1;
    if (ts.isReturnStatement(st) && !isLast) {
      failAt(st, "TSB1100", "Arrow block bodies must only use `return` as the final statement in v0.");
    }
    if (isLast && ts.isReturnStatement(st)) {
      return {
        kind: "block",
        stmts,
        tail: st.expression ? lowerExpr(ctx, st.expression) : unitExpr(),
      };
    }
    stmts.push(...lowerStmt(ctx, st));
  }

  return { kind: "block", stmts, tail: unitExpr() };
}

function lowerArrowToClosure(
  ctx: EmitCtx,
  fn: ts.ArrowFunction,
  moveCapture: boolean
): RustExpr {
  if ((fn.typeParameters?.length ?? 0) > 0) {
    failAt(fn, "TSB1100", "Generic arrow functions are not supported in v0.");
  }

  const params: RustParam[] = [];
  const defaulted: DefaultedParam[] = [];
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) {
      failAt(p.name, "TSB1100", "Arrow function parameters must be identifiers in v0.");
    }
    if (p.name.text === "this") {
      failAt(p.name, "TSB1100", "Arrow functions cannot declare a `this` parameter in v0.");
    }
    if (!p.type) {
      failAt(p, "TSB1100", `Arrow function parameter '${p.name.text}' must have a type annotation in v0.`);
    }
    if (p.questionToken) {
      failAt(p, "TSB1100", "Arrow functions do not support optional parameters in v0.");
    }
    const ty = typeNodeToRust(p.type);
    if (p.initializer) {
      params.push({ name: p.name.text, type: optionType(ty) });
      defaulted.push({
        name: p.name.text,
        type: ty,
        initializer: p.initializer,
        span: spanFromNode(p),
      });
      continue;
    }
    params.push({ name: p.name.text, type: ty });
  }

  const body = lowerArrowBodyToExpr(ctx, fn.body, lowerDefaultParamPrelude(ctx, defaulted));

  return {
    kind: "closure",
    move: moveCapture,
    params,
    body,
  };
}

function escapeRustFormatSegment(text: string): string {
  return text.replaceAll("{", "{{").replaceAll("}", "}}");
}

type SwitchCaseLiteral = {
  readonly key: string;
  readonly display: string;
  readonly expr: RustExpr;
};

function parseSwitchCaseLiteral(caseExpr: ts.Expression): SwitchCaseLiteral {
  if (ts.isStringLiteral(caseExpr)) {
    return { key: `s:${caseExpr.text}`, display: JSON.stringify(caseExpr.text), expr: { kind: "string", value: caseExpr.text } };
  }
  if (ts.isNumericLiteral(caseExpr)) {
    return { key: `n:${caseExpr.text}`, display: caseExpr.text, expr: { kind: "number", text: caseExpr.text } };
  }
  if (ts.isPrefixUnaryExpression(caseExpr) && caseExpr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(caseExpr.operand)) {
    const value = `-${caseExpr.operand.text}`;
    return { key: `n:${value}`, display: value, expr: { kind: "number", text: value } };
  }
  if (caseExpr.kind === ts.SyntaxKind.TrueKeyword) {
    return { key: "b:true", display: "true", expr: { kind: "bool", value: true } };
  }
  if (caseExpr.kind === ts.SyntaxKind.FalseKeyword) {
    return { key: "b:false", display: "false", expr: { kind: "bool", value: false } };
  }
  failAt(caseExpr, "TSB2211", "Non-union switch cases must be literal labels (string, number, boolean) in v0.");
}

function lowerExpr(ctx: EmitCtx, expr: ts.Expression): RustExpr {
  if (ts.isParenthesizedExpression(expr)) return { kind: "paren", expr: lowerExpr(ctx, expr.expression) };

  if (ts.isPropertyAccessChain(expr) || ts.isElementAccessChain(expr) || ts.isCallChain(expr)) {
    failAt(expr, "TSB1114", "Optional chaining (`?.`) is not supported in v0.");
  }

  if (ts.isAwaitExpression(expr)) {
    if (!ctx.inAsync) {
      failAt(expr, "TSB1308", "`await` is only supported inside async functions in v0.");
    }
    return { kind: "await", expr: lowerExpr(ctx, expr.expression) };
  }

  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    if (!ctx.thisName) {
      failAt(expr, "TSB1112", "`this` is only supported inside methods/constructors in v0.");
    }
    return identExpr(ctx.thisName);
  }

  if (ts.isArrowFunction(expr)) {
    return lowerArrowToClosure(ctx, expr, false);
  }

  if (ts.isIdentifier(expr)) {
    if (expr.text === "undefined") {
      failAt(expr, "TSB1101", "The value 'undefined' is not supported in v0; use Option/None or () explicitly.");
    }
    const kernel = kernelDeclForIdentifier(ctx, expr);
    if (kernel) {
      failAt(expr, "TSB1406", `Kernel values are compile-time only in v0; use ${expr.text}.launch(...).`);
    }
    return identExpr(expr.text);
  }
  if (ts.isNoSubstitutionTemplateLiteral(expr)) return { kind: "string", value: expr.text };
  if (ts.isTemplateExpression(expr)) {
    const formatParts: string[] = [escapeRustFormatSegment(expr.head.text)];
    const args: RustExpr[] = [];
    for (const span of expr.templateSpans) {
      formatParts.push("{}");
      formatParts.push(escapeRustFormatSegment(span.literal.text));
      args.push(lowerExpr(ctx, span.expression));
    }
    return {
      kind: "macro_call",
      name: "format",
      args: [{ kind: "string", value: formatParts.join("") }, ...args],
    };
  }
  if (ts.isNumericLiteral(expr)) return { kind: "number", text: expr.text };
  if (ts.isStringLiteral(expr)) return { kind: "string", value: expr.text };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { kind: "bool", value: true };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { kind: "bool", value: false };

  if (ts.isVoidExpression(expr)) {
    const inner = lowerExpr(ctx, expr.expression);
    return {
      kind: "block",
      stmts: [{ kind: "let", pattern: { kind: "wild" }, mut: false, init: inner }],
      tail: unitExpr(),
    };
  }

  if (ts.isAsExpression(expr)) {
    const inner = lowerExpr(ctx, expr.expression);
    const ty = typeNodeToRust(expr.type);
    return { kind: "cast", expr: inner, type: ty };
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const base = expr.expression;
    if (ts.isIdentifier(base)) {
      const m = ctx.fieldBindings?.get(base.text);
      if (m) {
        const bound = m.get(expr.name.text);
        if (!bound) {
          failAt(expr.name, "TSB1116", `Property '${expr.name.text}' is not available on this union variant in v0.`);
        }
        return identExpr(bound);
      }

      const unionDef = unionDefFromIdentifier(ctx, base);
      if (unionDef && expr.name.text !== unionDef.discriminant) {
        failAt(
          expr.name,
          "TSB1116",
          `Property '${expr.name.text}' is not available on union '${unionDef.name}' without switch-based variant narrowing in v0.`
        );
      }

      // Associated items on nominal types (e.g., enum variants / associated consts) use `::` in Rust.
      if (isClassValue(ctx, base)) {
        return pathExpr([base.text, expr.name.text]);
      }
    }
    return { kind: "field", expr: lowerExpr(ctx, base), name: expr.name.text };
  }

  if (ts.isElementAccessExpression(expr)) {
    const index = expr.argumentExpression;
    if (!index) failAt(expr, "TSB1110", "Element access must have an index expression in v0.");
    const baseTy = ctx.checker.getTypeAtLocation(expr.expression);
    if (isTupleType(baseTy) && ts.isNumericLiteral(index)) {
      const n = Number.parseInt(index.text, 10);
      if (Number.isInteger(n) && n >= 0) {
        return { kind: "field", expr: lowerExpr(ctx, expr.expression), name: String(n) };
      }
    }
    return { kind: "index", expr: lowerExpr(ctx, expr.expression), index: lowerExpr(ctx, index) };
  }

  if (ts.isArrayLiteralExpression(expr)) {
    const ctxt = ctx.checker.getContextualType(expr);
    const ty = ctx.checker.getTypeAtLocation(expr);
    if (isArrayNType(ctxt ?? ty)) {
      const elems: RustExpr[] = [];
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          failAt(el, "TSB1111", "Array spread is not supported in v0.");
        }
        elems.push(lowerExpr(ctx, el));
      }
      return { kind: "array", elems };
    }
    if (isTupleType(ctxt ?? ty)) {
      const elems: RustExpr[] = [];
      for (const el of expr.elements) {
        if (ts.isSpreadElement(el)) {
          failAt(el, "TSB1111", "Array spread is not supported in v0.");
        }
        elems.push(lowerExpr(ctx, el));
      }
      if (elems.length === 0) return unitExpr();
      return { kind: "tuple", elems };
    }
    const args: RustExpr[] = [];
    for (const el of expr.elements) {
      if (ts.isSpreadElement(el)) {
        failAt(el, "TSB1111", "Array spread is not supported in v0.");
      }
      args.push(lowerExpr(ctx, el));
    }
    return { kind: "macro_call", name: "vec", args };
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const props = new Map<string, ts.Expression>();
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) {
        failAt(p, "TSB1118", "Object spread is not supported in v0.");
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        if (props.has(p.name.text)) failAt(p.name, "TSB1125", `Duplicate property '${p.name.text}' in object literal.`);
        props.set(p.name.text, p.name);
        continue;
      }
      if (!ts.isPropertyAssignment(p)) {
        failAt(p, "TSB1119", "Unsupported object literal property form in v0.");
      }
      if (!ts.isIdentifier(p.name)) {
        failAt(p.name, "TSB1120", "Only identifier-named object literal properties are supported in v0.");
      }
      if (props.has(p.name.text)) failAt(p.name, "TSB1125", `Duplicate property '${p.name.text}' in object literal.`);
      props.set(p.name.text, p.initializer);
    }

    const ctxt = ctx.checker.getContextualType(expr);
    if (ctxt) {
      const key = unionKeyFromType(ctxt);
      const unionDef = key ? ctx.unions.get(key) : undefined;
      if (unionDef) {
        const discExpr = props.get(unionDef.discriminant);
        if (!discExpr || !ts.isStringLiteral(discExpr)) {
          failAt(
            expr,
            "TSB1121",
            `Union '${unionDef.name}' object literal must include ${unionDef.discriminant}: \"...\".`
          );
        }
        const tag = discExpr.text;
        const variant = unionDef.variants.find((v) => v.tag === tag);
        if (!variant) {
          failAt(discExpr, "TSB1122", `Unknown union tag '${tag}' for ${unionDef.name}.`);
        }

        const allowed = new Set<string>([unionDef.discriminant, ...variant.fields.map((f) => f.name)]);
        for (const k0 of props.keys()) {
          if (!allowed.has(k0)) {
            failAt(expr, "TSB1123", `Unknown property '${k0}' for union variant '${tag}' in ${unionDef.name}.`);
          }
        }

        const fields = variant.fields.map((f) => {
          const v = props.get(f.name);
          if (!v) {
            failAt(expr, "TSB1124", `Missing required field '${f.name}' for union variant '${tag}' in ${unionDef.name}.`);
          }
          return { name: f.name, expr: lowerExpr(ctx, v) };
        });

        if (fields.length === 0) {
          return pathExpr([unionDef.name, variant.name]);
        }
        return { kind: "struct_lit", typePath: { segments: [unionDef.name, variant.name] }, fields };
      }

      const structDef = key ? ctx.structs.get(key) : undefined;
      if (structDef) {
        for (const k0 of props.keys()) {
          if (!structDef.fields.some((f) => f.name === k0)) {
            failAt(expr, "TSB1126", `Unknown property '${k0}' for ${structDef.name} in v0.`);
          }
        }
        const fields = structDef.fields.map((f) => {
          const v = props.get(f.name);
          if (!v) {
            failAt(expr, "TSB1127", `Missing required field '${f.name}' for ${structDef.name} in v0.`);
          }
          return { name: f.name, expr: lowerExpr(ctx, v) };
        });
        if (fields.length === 0) return pathExpr([structDef.name]);
        return { kind: "struct_lit", typePath: { segments: [structDef.name] }, fields };
      }
    }

    // Shape structs: generate a private nominal struct for object literals without a known contextual type.
    for (const p of expr.properties) {
      if (ts.isShorthandPropertyAssignment(p)) {
        failAt(p, "TSB1130", "Shorthand object literal properties require a contextual nominal type in v0.");
      }
    }

    const span = spanFromNode(expr);
    const key = `${span.fileName}:${span.start}:${span.end}`;
    let def = ctx.shapeStructsByKey.get(key);
    if (!def) {
      const name = anonStructName(key);
      const fields: { readonly name: string; readonly type: RustType }[] = [];
      for (const p of expr.properties) {
        if (ts.isSpreadAssignment(p)) continue;
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
        const init = p.initializer;
        const ty = (() => {
          if (ts.isAsExpression(init)) return typeNodeToRust(init.type);
          if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) return pathType(["bool"]);
          failAt(
            init,
            "TSB1131",
            "Object literal fields without a contextual type must use explicit type assertions in v0 (e.g., x: 1 as i32)."
          );
        })();
        fields.push({ name: p.name.text, type: ty });
      }
      def = { key, name, span, vis: "private", fields };
      ctx.shapeStructsByKey.set(key, def);
      const sourceFileKey = normalizePath(expr.getSourceFile().fileName);
      const list = ctx.shapeStructsByFile.get(sourceFileKey) ?? [];
      list.push(def);
      ctx.shapeStructsByFile.set(sourceFileKey, list);
    }

    const fields = def.fields.map((f) => {
      const v = props.get(f.name);
      if (!v) failAt(expr, "TSB1132", `Missing required field '${f.name}' in object literal for ${def.name}.`);
      return { name: f.name, expr: lowerExpr(ctx, v) };
    });
    if (fields.length === 0) return pathExpr([def.name]);
    return { kind: "struct_lit", typePath: { segments: [def.name] }, fields };
  }

  if (ts.isNewExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) {
      failAt(expr.expression, "TSB1113", "new expressions must use an identifier constructor in v0.");
    }
    const typeArgs = (expr.typeArguments ?? []).map((t) => typeNodeToRust(t));
    const args = (expr.arguments ?? []).map((a) => lowerExpr(ctx, a));
    return {
      kind: "assoc_call",
      typePath: { segments: [expr.expression.text] },
      typeArgs,
      member: "new",
      args,
    };
  }

  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      failAt(expr.operatorToken, "TSB1201", "Nullish coalescing (`??`) is not supported in v0.");
    }
    const left = lowerExpr(ctx, expr.left);
    const right = lowerExpr(ctx, expr.right);
    const op = (() => {
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return "+";
        case ts.SyntaxKind.MinusToken:
          return "-";
        case ts.SyntaxKind.AsteriskToken:
          return "*";
        case ts.SyntaxKind.SlashToken:
          return "/";
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
          return "==";
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
          return "!=";
        case ts.SyntaxKind.LessThanToken:
          return "<";
        case ts.SyntaxKind.LessThanEqualsToken:
          return "<=";
        case ts.SyntaxKind.GreaterThanToken:
          return ">";
        case ts.SyntaxKind.GreaterThanEqualsToken:
          return ">=";
        case ts.SyntaxKind.AmpersandAmpersandToken:
          return "&&";
        case ts.SyntaxKind.BarBarToken:
          return "||";
        default:
          failAt(expr.operatorToken, "TSB1200", `Unsupported binary operator: ${expr.operatorToken.getText()}`);
      }
    })();
    return { kind: "binary", op, left, right };
  }

  if (ts.isCallExpression(expr)) {
    if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "then") {
      failAt(expr.expression.name, "TSB1306", "Promise `.then(...)` chains are not supported in v0; use `await`.");
    }

    // Kernel launch syntax: k.launch({ grid, block }, ...args)
    if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === "launch") {
      const recv = expr.expression.expression;
      if (ts.isIdentifier(recv)) {
        const kernel = kernelDeclForIdentifier(ctx, recv);
        if (kernel) {
          if (expr.arguments.length < 1) {
            failAt(expr, "TSB1470", "kernel.launch(...) requires a launch config argument in v0.");
          }
          const [cfg, ...rest] = expr.arguments;
          if (!cfg) {
            failAt(expr, "TSB1470", "kernel.launch(...) requires a launch config argument in v0.");
          }

          const unwrap = (e: ts.Expression): ts.Expression => {
            if (ts.isParenthesizedExpression(e)) return unwrap(e.expression);
            if (ts.isAsExpression(e)) return unwrap(e.expression);
            return e;
          };

          const cfg0 = unwrap(cfg);
          if (!ts.isObjectLiteralExpression(cfg0)) {
            failAt(cfg, "TSB1471", "kernel.launch(config, ...) requires an object-literal config in v0.");
          }

          const props = new Map<string, ts.Expression>();
          for (const p of cfg0.properties) {
            if (ts.isSpreadAssignment(p)) {
              failAt(p, "TSB1471", "kernel.launch(config, ...) does not support object spread in v0.");
            }
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
              failAt(p, "TSB1471", "kernel.launch(config, ...) requires identifier-named properties in v0.");
            }
            if (props.has(p.name.text)) {
              failAt(p.name, "TSB1471", `Duplicate property '${p.name.text}' in kernel launch config.`);
            }
            props.set(p.name.text, p.initializer);
          }

          const parseDim3 = (e: ts.Expression, label: string): readonly [ts.Expression, ts.Expression, ts.Expression] => {
            const e0 = unwrap(e);
            if (!ts.isArrayLiteralExpression(e0)) {
              failAt(e, "TSB1472", `kernel.launch config '${label}' must be a [x,y,z] array literal in v0.`);
            }
            if (e0.elements.length !== 3) {
              failAt(e0, "TSB1472", `kernel.launch config '${label}' must have exactly 3 elements in v0.`);
            }
            const els = e0.elements.map((el) => {
              if (ts.isSpreadElement(el)) {
                failAt(el, "TSB1472", `kernel.launch config '${label}' does not support spreads in v0.`);
              }
              return el as ts.Expression;
            });
            return [els[0]!, els[1]!, els[2]!];
          };

          const gridExpr = props.get("grid");
          const blockExpr = props.get("block");
          if (!gridExpr || !blockExpr) {
            failAt(cfg0, "TSB1473", "kernel.launch config must include both { grid, block } in v0.");
          }
          for (const k0 of props.keys()) {
            if (k0 !== "grid" && k0 !== "block") {
              failAt(cfg0, "TSB1473", `Unknown kernel.launch config property '${k0}' in v0.`);
            }
          }

          const grid = parseDim3(gridExpr, "grid");
          const block = parseDim3(blockExpr, "block");

          const dims = [
            lowerExpr(ctx, grid[0]),
            lowerExpr(ctx, grid[1]),
            lowerExpr(ctx, grid[2]),
            lowerExpr(ctx, block[0]),
            lowerExpr(ctx, block[1]),
            lowerExpr(ctx, block[2]),
          ];
          const kernelArgs = rest.map((a) => lowerExpr(ctx, a));

          ctx.gpuRuntime.used = true;
          return {
            kind: "call",
            callee: pathExpr(["__tsuba_cuda", `launch_${kernel.name}`]),
            args: [...dims, ...kernelArgs],
          };
        }
      }
    }

    let gpuCalleeOverride: RustExpr | undefined;
    if (ts.isIdentifier(expr.expression) && isFromTsubaGpuLang(ctx, expr.expression)) {
      const name = expr.expression.text;
      if (name === "kernel") {
        failAt(expr, "TSB1400", "kernel(...) is compile-time only and must appear as a top-level const initializer.");
      }
      if (name === "deviceMalloc") {
        if (expr.arguments.length !== 1) {
          failAt(expr, "TSB1474", "deviceMalloc<T>(len) must have exactly one argument in v0.");
        }
        if ((expr.typeArguments?.length ?? 0) !== 1) {
          failAt(expr, "TSB1475", "deviceMalloc<T>(len) requires exactly one explicit type argument in v0.");
        }
        const len = lowerExpr(ctx, expr.arguments[0]!);
        const t0 = expr.typeArguments?.[0];
        if (!t0) {
          failAt(expr, "TSB1475", "deviceMalloc<T>(len) requires exactly one explicit type argument in v0.");
        }
        const ty = typeNodeToRust(t0);
        ctx.gpuRuntime.used = true;
        return {
          kind: "path_call",
          path: { segments: ["__tsuba_cuda", "device_malloc"] },
          typeArgs: [ty],
          args: [len],
        };
      }
      if (name === "deviceFree") {
        ctx.gpuRuntime.used = true;
        gpuCalleeOverride = pathExpr(["__tsuba_cuda", "device_free"]);
      } else if (name === "memcpyHtoD") {
        ctx.gpuRuntime.used = true;
        gpuCalleeOverride = pathExpr(["__tsuba_cuda", "memcpy_htod"]);
      } else if (name === "memcpyDtoH") {
        ctx.gpuRuntime.used = true;
        gpuCalleeOverride = pathExpr(["__tsuba_cuda", "memcpy_dtoh"]);
      } else {
        failAt(expr.expression, "TSB1476", `@tsuba/gpu '${name}' is only supported inside kernel code in v0.`);
      }
    }

    // std prelude helpers
    if (ts.isIdentifier(expr.expression) && isFromTsubaStdPrelude(ctx, expr.expression)) {
      if (expr.expression.text === "Ok") {
        if (expr.arguments.length === 0) {
          return { kind: "call", callee: identExpr("Ok"), args: [unitExpr()] };
        }
        if (
          expr.arguments.length === 1 &&
          ts.isIdentifier(expr.arguments[0]!) &&
          expr.arguments[0]!.text === "undefined"
        ) {
          return { kind: "call", callee: identExpr("Ok"), args: [unitExpr()] };
        }
      }

      if (isBottomMacroMarker(expr.expression.text)) {
        return {
          kind: "macro_call",
          name: expr.expression.text,
          args: expr.arguments.map((a) => lowerExpr(ctx, a)),
        };
      }
    }

    // Core markers (compile-time only)
    if (ts.isIdentifier(expr.expression) && isFromTsubaCoreLang(ctx, expr.expression)) {
      if (expr.expression.text === "move") {
        if (expr.arguments.length !== 1) {
          failAt(expr, "TSB1302", "move(...) must have exactly one argument.");
        }
        const [arg] = expr.arguments;
        if (!arg || !ts.isArrowFunction(arg)) {
          failAt(expr, "TSB1303", "move(...) requires an arrow function argument in v0.");
        }
        return lowerArrowToClosure(ctx, arg, true);
      }
      if (expr.expression.text === "q") {
        if (expr.arguments.length !== 1) failAt(expr, "TSB1300", "q(...) must have exactly one argument.");
        const inner = lowerExpr(ctx, expr.arguments[0]!);
        return { kind: "try", expr: inner };
      }
      if (expr.expression.text === "unsafe") {
        if (expr.arguments.length !== 1) {
          failAt(expr, "TSB1302", "unsafe(...) must have exactly one argument.");
        }
        const [arg] = expr.arguments;
        if (!arg || !ts.isArrowFunction(arg)) {
          failAt(expr, "TSB1303", "unsafe(...) requires an arrow function argument in v0.");
        }
        if (ts.isBlock(arg.body)) {
          failAt(
            arg.body,
            "TSB1304",
            "unsafe(() => { ... }) blocks are not supported in v0 (use expression body)."
          );
        }
        const inner = lowerExpr(ctx, arg.body);
        return { kind: "unsafe", expr: inner };
      }

      if (isBottomMacroMarker(expr.expression.text)) {
        return {
          kind: "macro_call",
          name: expr.expression.text,
          args: expr.arguments.map((a) => lowerExpr(ctx, a)),
        };
      }
    }

    // Associated functions: `Type.method<Ts...>(args...)` -> `Type::<Ts...>::method(args...)`
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const obj = expr.expression.expression;
      if (ts.isIdentifier(obj) && isClassValue(ctx, obj)) {
        const member = expr.expression.name.text;

        const baseRust =
          isFromTsubaStdPrelude(ctx, obj) && obj.text === "HashMap"
            ? "std::collections::HashMap"
            : obj.text;

        const typeArgs = (expr.typeArguments ?? []).map((t) => typeNodeToRust(t));
        const args = expr.arguments.map((a) => lowerExpr(ctx, a));
        return {
          kind: "assoc_call",
          typePath: { segments: splitRustPath(baseRust) },
          typeArgs,
          member,
          args,
        };
      }
    }

    const args = expr.arguments.map((a) => lowerExpr(ctx, a));

    if (isMacroType(ctx.checker, expr.expression)) {
      if ((expr.typeArguments?.length ?? 0) > 0) {
        failAt(expr, "TSB1305", "Macro calls must not have type arguments in v0.");
      }
      if (!ts.isIdentifier(expr.expression)) {
        failAt(expr.expression, "TSB1301", "Macro calls must use an identifier callee in v0.");
      }
      return { kind: "macro_call", name: expr.expression.text, args };
    }

    let callArgs = args;
    const sig = ctx.checker.getResolvedSignature(expr);
    const decl = sig?.declaration;
    if (decl && ts.isFunctionLike(decl)) {
      const params = decl.parameters;
      const effectiveParams =
        params.length > 0 &&
        ts.isIdentifier(params[0]!.name) &&
        params[0]!.name.text === "this"
          ? params.slice(1)
          : params;

      const next: RustExpr[] = [];
      for (let i = 0; i < effectiveParams.length; i++) {
        const param = effectiveParams[i]!;
        const arg = callArgs[i];
        const hasDefault = param.initializer !== undefined;

        if (!arg) {
          if (hasDefault) next.push(noneExpr());
          continue;
        }

        let nextArg = arg;
        if (param.type) {
          const rustTy = typeNodeToRust(param.type);
          if (rustTy.kind === "ref") {
            if (rustTy.mut) {
              const okPlace =
                nextArg.kind === "ident" || nextArg.kind === "field" || nextArg.kind === "index";
              if (!okPlace) {
                failAt(expr.arguments[i]!, "TSB1310", "&mut arguments must be place expressions in v0.");
              }
            }
            nextArg = { kind: "borrow", mut: rustTy.mut, expr: nextArg };
          }
        }

        if (hasDefault) {
          next.push(someExpr(nextArg));
          continue;
        }
        next.push(nextArg);
      }

      for (let i = effectiveParams.length; i < callArgs.length; i++) {
        next.push(callArgs[i]!);
      }
      callArgs = next;
    }

    if ((expr.typeArguments?.length ?? 0) > 0) {
      if (!ts.isIdentifier(expr.expression)) {
        failAt(expr.expression, "TSB1311", "Generic call expressions are only supported on identifier callees in v0.");
      }
      if (!decl || !ts.isFunctionDeclaration(decl)) {
        failAt(
          expr.expression,
          "TSB1312",
          "Generic call expressions require the callee to resolve to a declared function (not a value/closure) in v0."
        );
      }
      const typeArgs = (expr.typeArguments ?? []).map((t) => typeNodeToRust(t));
      return { kind: "path_call", path: { segments: [expr.expression.text] }, typeArgs, args: callArgs };
    }

    const callee = gpuCalleeOverride ?? lowerExpr(ctx, expr.expression);
    return { kind: "call", callee, args: callArgs };
  }

  failAt(expr, "TSB1100", `Unsupported expression: ${expr.getText()}`);
}

function lowerVarDeclList(ctx: EmitCtx, declList: ts.VariableDeclarationList): RustStmt[] {
  const out: RustStmt[] = [];
  for (const decl of declList.declarations) {
    if (!ts.isIdentifier(decl.name)) {
      failAt(decl.name, "TSB2001", "Destructuring declarations are not supported in v0.");
    }
    if (!decl.initializer) {
      failAt(decl, "TSB2002", `Variable '${decl.name.text}' must have an initializer in v0.`);
    }

    const isMut = isMutMarkerType(decl.type);
    if (isMut && decl.type && ts.isTypeReferenceNode(decl.type)) {
      const inner = decl.type.typeArguments?.[0];
      if (!inner) failAt(decl.type, "TSB2010", "mut<T> must have exactly one type argument.");
      out.push({
        kind: "let",
        span: spanFromNode(decl),
        pattern: { kind: "ident", name: decl.name.text },
        mut: true,
        type: typeNodeToRust(inner),
        init: lowerExpr(ctx, decl.initializer),
      });
      continue;
    }

    out.push({
      kind: "let",
      span: spanFromNode(decl),
      pattern: { kind: "ident", name: decl.name.text },
      mut: false,
      type: decl.type ? typeNodeToRust(decl.type) : undefined,
      init: lowerExpr(ctx, decl.initializer),
    });
  }
  return out;
}

function lowerExprStmt(ctx: EmitCtx, expr: ts.Expression): RustStmt[] {
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return [
      {
        kind: "assign",
        span: spanFromNode(expr),
        target: lowerExpr(ctx, expr.left),
        expr: lowerExpr(ctx, expr.right),
      },
    ];
  }

  if (
    (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) &&
    (expr.operator === ts.SyntaxKind.PlusPlusToken || expr.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    const operand = expr.operand;
    if (!ts.isIdentifier(operand)) {
      failAt(expr, "TSB2110", "++/-- is only supported on identifiers in v0.");
    }
    const op = expr.operator === ts.SyntaxKind.PlusPlusToken ? "+" : "-";
    const name = operand.text;
    return [
      {
        kind: "assign",
        span: spanFromNode(expr),
        target: identExpr(name),
        expr: { kind: "binary", op, left: identExpr(name), right: { kind: "number", text: "1" } },
      },
    ];
  }

  return [{ kind: "expr", span: spanFromNode(expr), expr: lowerExpr(ctx, expr) }];
}

function lowerStmt(ctx: EmitCtx, st: ts.Statement): RustStmt[] {
  if (ts.isBlock(st)) {
    const body: RustStmt[] = [];
    for (const s of st.statements) body.push(...lowerStmt(ctx, s));
    return [{ kind: "block", span: spanFromNode(st), body }];
  }

  if (ts.isVariableStatement(st)) {
    return lowerVarDeclList(ctx, st.declarationList);
  }

  if (ts.isExpressionStatement(st)) {
    return lowerExprStmt(ctx, st.expression);
  }

  if (ts.isReturnStatement(st)) {
    return [{ kind: "return", span: spanFromNode(st), expr: st.expression ? lowerExpr(ctx, st.expression) : undefined }];
  }

  if (ts.isIfStatement(st)) {
    const cond = lowerExpr(ctx, st.expression);
    const then = lowerStmtBlock(ctx, st.thenStatement);
    const elseStmts = st.elseStatement ? lowerStmtBlock(ctx, st.elseStatement) : undefined;
    return [{ kind: "if", span: spanFromNode(st), cond, then, else: elseStmts }];
  }

  if (ts.isWhileStatement(st)) {
    const cond = lowerExpr(ctx, st.expression);
    const body = lowerStmtBlock(ctx, st.statement);
    return [{ kind: "while", span: spanFromNode(st), cond, body }];
  }

  if (ts.isSwitchStatement(st)) {
    const e = st.expression;

    const lowerClauseBody = (innerCtx: EmitCtx, clause: ts.CaseOrDefaultClause): RustStmt[] => {
      if (clause.statements.length === 0) {
        failAt(clause, "TSB2207", "Empty switch cases are not supported in v0 (no fallthrough).");
      }
      const last = clause.statements.at(-1);
      if (!last) failAt(clause, "TSB2207", "Empty switch cases are not supported in v0 (no fallthrough).");
      const bodyNodes = ts.isBreakStatement(last) ? clause.statements.slice(0, -1) : clause.statements;
      if (!ts.isBreakStatement(last) && !ts.isReturnStatement(last)) {
        failAt(
          last,
          "TSB2208",
          "Switch cases must end with `break;` or `return ...;` in v0 (no fallthrough)."
        );
      }
      for (const s0 of bodyNodes) {
        if (ts.isBreakStatement(s0)) {
          failAt(s0, "TSB2209", "break; is only allowed as the final statement in a switch case in v0.");
        }
      }
      const lowered: RustStmt[] = [];
      for (const s0 of bodyNodes) lowered.push(...lowerStmt(innerCtx, s0));
      return lowered;
    };

    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const targetIdent = e.expression;
      const discName = e.name.text;
      const targetType = ctx.checker.getTypeAtLocation(targetIdent);
      const key = unionKeyFromType(targetType);
      const def = key ? ctx.unions.get(key) : undefined;

      if (def) {
        if (discName !== def.discriminant) {
          failAt(
            e.name,
            "TSB2202",
            `switch(...) discriminant '${discName}' does not match union '${def.name}' discriminant '${def.discriminant}'.`
          );
        }

        const arms: RustMatchArm[] = [];
        const coveredTags = new Set<string>();

        for (const clause of st.caseBlock.clauses) {
          if (ts.isDefaultClause(clause)) {
            failAt(clause, "TSB2203", "default clauses are not supported for discriminated unions in v0 (must be exhaustive).");
          }
          const caseExpr = clause.expression;
          if (!ts.isStringLiteral(caseExpr)) {
            failAt(caseExpr, "TSB2204", "Union switch cases must use string literal tags in v0.");
          }
          const tag = caseExpr.text;
          if (coveredTags.has(tag)) {
            failAt(caseExpr, "TSB2205", `Duplicate union case '${tag}' in switch.`);
          }
          coveredTags.add(tag);

          const variant = def.variants.find((v) => v.tag === tag);
          if (!variant) {
            failAt(caseExpr, "TSB2206", `Unknown union tag '${tag}' for ${def.name}.`);
          }

          const fieldMap = new Map<string, string>();
          for (const f of variant.fields) fieldMap.set(f.name, f.name);
          const inherited = ctx.fieldBindings ? new Map(ctx.fieldBindings) : new Map<string, ReadonlyMap<string, string>>();
          inherited.set(targetIdent.text, fieldMap);
          const armCtx: EmitCtx = {
            checker: ctx.checker,
            unions: ctx.unions,
            structs: ctx.structs,
            traitsByKey: ctx.traitsByKey,
            traitsByName: ctx.traitsByName,
            shapeStructsByKey: ctx.shapeStructsByKey,
            shapeStructsByFile: ctx.shapeStructsByFile,
            kernelDeclBySymbol: ctx.kernelDeclBySymbol,
            gpuRuntime: ctx.gpuRuntime,
            generatedNameCounters: ctx.generatedNameCounters,
            thisName: ctx.thisName,
            fieldBindings: inherited,
          };

          const body = lowerClauseBody(armCtx, clause);

          arms.push({
            pattern: {
              kind: "enum_struct",
              path: { segments: [def.name, variant.name] },
              fields: variant.fields.map((f) => ({ name: f.name, bind: { kind: "ident", name: f.name } })),
            },
            body,
          });
        }

        if (coveredTags.size !== def.variants.length) {
          const missing = def.variants
            .map((v) => v.tag)
            .filter((t) => !coveredTags.has(t));
          failAt(st, "TSB2210", `Non-exhaustive switch for union '${def.name}'. Missing cases: ${missing.join(", ")}`);
        }

        return [{ kind: "match", span: spanFromNode(st), expr: identExpr(targetIdent.text), arms }];
      }
    }

    const tempName = `__tsuba_switch_${ctx.generatedNameCounters.switchTemp++}`;
    const tempInit = lowerExpr(ctx, st.expression);
    const defaultClause = st.caseBlock.clauses.find((clause) => ts.isDefaultClause(clause));
    const branchBodies: {
      readonly lit: SwitchCaseLiteral;
      readonly body: readonly RustStmt[];
    }[] = [];
    const seenKeys = new Set<string>();

    for (const clause of st.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) continue;
      const lit = parseSwitchCaseLiteral(clause.expression);
      if (seenKeys.has(lit.key)) {
        failAt(clause.expression, "TSB2212", `Duplicate non-union switch case ${lit.display}.`);
      }
      seenKeys.add(lit.key);
      branchBodies.push({ lit, body: lowerClauseBody(ctx, clause) });
    }

    const defaultBody = defaultClause ? lowerClauseBody(ctx, defaultClause) : undefined;

    let tailElse = defaultBody;
    for (let i = branchBodies.length - 1; i >= 0; i--) {
      const branch = branchBodies[i]!;
      const cond: RustExpr = {
        kind: "binary",
        op: "==",
        left: identExpr(tempName),
        right: branch.lit.expr,
      };
      const nextIf: RustStmt = {
        kind: "if",
        span: spanFromNode(st),
        cond,
        then: [...branch.body],
        else: tailElse,
      };
      tailElse = [nextIf];
    }

    const blockBody: RustStmt[] = [
      {
        kind: "let",
        span: spanFromNode(st.expression),
        pattern: { kind: "ident", name: tempName },
        mut: false,
        init: tempInit,
      },
    ];
    if (tailElse) {
      blockBody.push(...tailElse);
    }
    return [{ kind: "block", span: spanFromNode(st), body: blockBody }];
  }

  if (ts.isBreakStatement(st)) {
    return [{ kind: "break", span: spanFromNode(st) }];
  }

  if (ts.isContinueStatement(st)) {
    return [{ kind: "continue", span: spanFromNode(st) }];
  }

  if (ts.isForStatement(st)) {
    const init = st.initializer;
    const condExpr = st.condition ?? ts.factory.createTrue();
    const inc = st.incrementor;

    const initStmts: RustStmt[] = [];
    if (!init) {
      // ok
    } else if (ts.isVariableDeclarationList(init)) {
      // v0: for-loop scoping must be preserved, so we always wrap a `for` lowering in a block.
      const isVar = (init.flags & ts.NodeFlags.Let) === 0 && (init.flags & ts.NodeFlags.Const) === 0;
      if (isVar) failAt(init, "TSB2120", "for-loop `var` declarations are not supported in v0 (use let/const).");
      initStmts.push(...lowerVarDeclList(ctx, init));
    } else {
      // Expression initializer (e.g., i = 0)
      initStmts.push(...lowerExprStmt(ctx, init));
    }

    const incStmts = inc ? lowerExprStmt(ctx, inc) : [];
    const bodyStmts = lowerStmtBlock(ctx, st.statement);

    const whileBody = [...bodyStmts, ...incStmts];
    const span = spanFromNode(st);
    const lowered: RustStmt = { kind: "while", span, cond: lowerExpr(ctx, condExpr), body: whileBody };
    return [{ kind: "block", span, body: [...initStmts, lowered] }];
  }

  failAt(st, "TSB2100", `Unsupported statement: ${st.getText()}`);
}

function lowerStmtBlock(ctx: EmitCtx, st: ts.Statement): RustStmt[] {
  if (ts.isBlock(st)) {
    const out: RustStmt[] = [];
    for (const s of st.statements) out.push(...lowerStmt(ctx, s));
    return out;
  }
  return lowerStmt(ctx, st);
}

function lowerFunction(ctx: EmitCtx, fnDecl: ts.FunctionDeclaration, attrs: readonly string[]): RustItem {
  if (!fnDecl.name) failAt(fnDecl, "TSB3000", "Unnamed functions are not supported in v0.");
  if (!fnDecl.body) failAt(fnDecl, "TSB3001", `Function '${fnDecl.name.text}' must have a body in v0.`);

  const span = spanFromNode(fnDecl);
  const hasExport = fnDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const isAsync = hasModifier(fnDecl, ts.SyntaxKind.AsyncKeyword);
  const vis = hasExport ? "pub" : "private";
  const typeParams = lowerTypeParameters(
    ctx.checker,
    fnDecl,
    `Function '${fnDecl.name.text}'`,
    fnDecl.typeParameters,
    "TSB3005"
  );

  const params: RustParam[] = [];
  const defaulted: DefaultedParam[] = [];
  for (const p of fnDecl.parameters) {
    if (!ts.isIdentifier(p.name)) {
      failAt(p.name, "TSB3002", `Function '${fnDecl.name.text}': destructuring params are not supported in v0.`);
    }
    if (!p.type) {
      failAt(
        p,
        "TSB3003",
        `Function '${fnDecl.name.text}': parameter '${p.name.text}' needs a type annotation in v0.`
      );
    }
    if (p.questionToken) {
      failAt(p, "TSB3004", `Function '${fnDecl.name.text}': optional params are not supported in v0.`);
    }
    const ty = typeNodeToRust(p.type);
    if (p.initializer) {
      params.push({ name: p.name.text, type: optionType(ty) });
      defaulted.push({
        name: p.name.text,
        type: ty,
        initializer: p.initializer,
        span: spanFromNode(p),
      });
      continue;
    }
    params.push({ name: p.name.text, type: ty });
  }

  const ret = isAsync
    ? typeNodeToRust(unwrapPromiseInnerType(fnDecl, `Function '${fnDecl.name.text}'`, fnDecl.type, "TSB3010"))
    : typeNodeToRust(fnDecl.type);
  const fnCtx: EmitCtx = { ...ctx, inAsync: isAsync };
  const body: RustStmt[] = [...lowerDefaultParamPrelude(fnCtx, defaulted)];
  for (const st of fnDecl.body.statements) body.push(...lowerStmt(fnCtx, st));

  return {
    kind: "fn",
    span,
    vis,
    async: isAsync,
    typeParams,
    receiver: { kind: "none" },
    name: fnDecl.name.text,
    params,
    ret,
    attrs,
    body,
  };
}

function lowerClass(ctx: EmitCtx, cls: ts.ClassDeclaration, attrs: readonly string[]): readonly RustItem[] {
  if (!cls.name) failAt(cls, "TSB4000", "Anonymous classes are not supported in v0.");

  const className = cls.name.text;
  const classSpan = spanFromNode(cls);
  const classTypeParams = lowerTypeParameters(ctx.checker, cls, `Class '${className}'`, cls.typeParameters, "TSB4001");
  const classTypeArgs = classTypeParams.map((tp) => pathType([tp.name]));
  const classTypePath = pathType([className], classTypeArgs);

  const implementsTraits: { readonly node: ts.ExpressionWithTypeArguments; readonly traitPath: RustType }[] = [];
  if (cls.heritageClauses && cls.heritageClauses.length > 0) {
    for (const h of cls.heritageClauses) {
      if (h.token === ts.SyntaxKind.ExtendsKeyword) {
        failAt(h, "TSB4002", "Class extends is not supported in v0.");
      }
      if (h.token !== ts.SyntaxKind.ImplementsKeyword) {
        failAt(h, "TSB4002", "Unsupported class heritage in v0.");
      }
      for (const t0 of h.types) {
        if (!ts.isExpressionWithTypeArguments(t0)) {
          failAt(t0, "TSB4003", "Unsupported implements clause in v0.");
        }
        const traitPath = lowerExprWithTypeArgsToRustType(`Class '${className}'`, t0, "TSB4005");
        implementsTraits.push({ node: t0, traitPath });
      }
    }
  }

  const hasExport = cls.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const classVis = hasExport ? "pub" : "private";

  const fields: { readonly name: string; readonly vis: "pub" | "private"; readonly type: RustType; readonly init?: RustExpr }[] =
    [];
  const fieldByName = new Map<string, number>();

  let ctor: ts.ConstructorDeclaration | undefined;
  const methods: ts.MethodDeclaration[] = [];

  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m)) {
      if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) ?? false) {
        failAt(m, "TSB4010", "Static fields are not supported in v0.");
      }
      if (!ts.isIdentifier(m.name)) {
        failAt(m.name, "TSB4011", "Only identifier-named fields are supported in v0.");
      }
      const name = m.name.text;
      if (fieldByName.has(name)) failAt(m.name, "TSB4012", `Duplicate field '${name}'.`);
      if (!m.type) failAt(m, "TSB4013", `Field '${name}' must have a type annotation in v0.`);

      const isPrivate =
        m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword) ??
        false;
      const vis = isPrivate ? "private" : "pub";

      const init = m.initializer ? lowerExpr(ctx, m.initializer) : undefined;
      const ty = typeNodeToRust(m.type);

      fieldByName.set(name, fields.length);
      fields.push({ name, vis, type: ty, init });
      continue;
    }

    if (ts.isConstructorDeclaration(m)) {
      if (ctor) failAt(m, "TSB4020", "Only one constructor is supported in v0.");
      if (!m.body) failAt(m, "TSB4021", "Constructor must have a body in v0.");
      ctor = m;
      continue;
    }

    if (ts.isMethodDeclaration(m)) {
      methods.push(m);
      continue;
    }

    if (
      ts.isSemicolonClassElement(m) ||
      ts.isIndexSignatureDeclaration(m) ||
      ts.isGetAccessorDeclaration(m) ||
      ts.isSetAccessorDeclaration(m)
    ) {
      failAt(m, "TSB4030", "Unsupported class member in v0.");
    }

    failAt(m, "TSB4031", "Unsupported class member in v0.");
  }

  const structFields = fields.map((f): { readonly vis: "pub" | "private"; readonly name: string; readonly type: RustType } => ({
    vis: f.vis,
    name: f.name,
    type: f.type,
  }));

  const structItem: RustItem = {
    kind: "struct",
    span: classSpan,
    vis: classVis,
    name: className,
    typeParams: classTypeParams,
    attrs,
    fields: structFields,
  };

  // Build `new(...) -> Self` from constructor assignments + field initializers.
  const ctorParams: RustParam[] = [];
  const assigned = new Map<string, RustExpr>();

  if (ctor) {
    for (const p of ctor.parameters) {
      if (!ts.isIdentifier(p.name)) failAt(p.name, "TSB4022", "Destructuring ctor params are not supported in v0.");
      if (!p.type) failAt(p, "TSB4023", `Constructor param '${p.name.text}' must have a type annotation in v0.`);
      if (p.questionToken) {
        failAt(p, "TSB4024", "Optional constructor parameters are not supported in v0.");
      }
      if (p.initializer) {
        failAt(p, "TSB4024", "Default constructor parameters are not supported in v0.");
      }
      ctorParams.push({ name: p.name.text, type: typeNodeToRust(p.type) });
    }

    for (const st of ctor.body!.statements) {
      if (!ts.isExpressionStatement(st)) failAt(st, "TSB4025", "Constructor body is restricted in v0.");
      const e = st.expression;
      if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        failAt(e, "TSB4026", "Constructor body must only contain assignments in v0.");
      }
      if (!ts.isPropertyAccessExpression(e.left) || e.left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
        failAt(e.left, "TSB4027", "Constructor assignments must be of the form this.field = expr in v0.");
      }
      const fieldName = e.left.name.text;
      if (!fieldByName.has(fieldName)) {
        failAt(e.left.name, "TSB4028", `Unknown field '${fieldName}' in constructor assignment.`);
      }
      assigned.set(fieldName, lowerExpr(ctx, e.right));
    }
  }

  const initFields: { readonly name: string; readonly expr: RustExpr }[] = [];
  for (const f of fields) {
    const v = assigned.get(f.name) ?? f.init;
    if (!v) failAt(cls, "TSB4029", `Field '${f.name}' is not initialized (add an initializer or assign in constructor).`);
    initFields.push({ name: f.name, expr: v });
  }

  const newItem: RustItem = {
    kind: "fn",
    span: classSpan,
    vis: "pub",
    async: false,
    typeParams: [],
    receiver: { kind: "none" },
    name: "new",
    params: ctorParams,
    ret: classTypePath,
    attrs: [],
    body: [
      {
        kind: "return",
        expr:
          initFields.length === 0
            ? pathExpr([className])
            : { kind: "struct_lit", typePath: { segments: [className] }, fields: initFields },
      },
    ],
  };

  const implItems: RustItem[] = [newItem];
  const classMethodsByName = new Map<
    string,
    {
      readonly receiver: { readonly mut: boolean; readonly lifetime?: string };
      readonly typeParams: readonly RustGenericParam[];
      readonly params: readonly RustParam[];
      readonly ret: RustType;
      readonly body: readonly RustStmt[];
      readonly span: Span;
      readonly async: boolean;
    }
  >();

  for (const m of methods) {
    if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) ?? false) {
      failAt(m, "TSB4100", "Static methods are not supported in v0.");
    }
    if (!ts.isIdentifier(m.name)) failAt(m.name, "TSB4101", "Only identifier-named methods are supported in v0.");
    if (!m.body) failAt(m, "TSB4102", "Method must have a body in v0.");
    const isAsync = hasModifier(m, ts.SyntaxKind.AsyncKeyword);
    const methodTypeParams = lowerTypeParameters(
      ctx.checker,
      m,
      `Method '${m.name.text}'`,
      m.typeParameters,
      "TSB4103"
    );

    const isPrivate =
      m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword) ??
      false;
    const vis = isPrivate ? "private" : "pub";

    let receiver: { readonly kind: "ref_self"; readonly mut: boolean; readonly lifetime?: string } = {
      kind: "ref_self",
      mut: false,
    };
    const params: RustParam[] = [];
    const defaulted: DefaultedParam[] = [];
    for (let i = 0; i < m.parameters.length; i++) {
      const p = m.parameters[i]!;
      if (!ts.isIdentifier(p.name)) failAt(p.name, "TSB4104", "Destructuring params are not supported in v0.");
      if (p.name.text === "this" && i === 0) {
        const rec = methodReceiverFromThisParam(p.type);
        if (!rec) {
          failAt(p, "TSB4105", "Method `this:` parameter must be ref<...> or mutref<...> in v0.");
        }
        receiver = { kind: "ref_self", mut: rec.mut, lifetime: rec.lifetime };
        continue;
      }
      if (!p.type) failAt(p, "TSB4106", `Method param '${p.name.text}' must have a type annotation in v0.`);
      if (p.questionToken) {
        failAt(p, "TSB4107", "Optional params are not supported in v0.");
      }
      const ty = typeNodeToRust(p.type);
      if (p.initializer) {
        params.push({ name: p.name.text, type: optionType(ty) });
        defaulted.push({
          name: p.name.text,
          type: ty,
          initializer: p.initializer,
          span: spanFromNode(p),
        });
        continue;
      }
      params.push({ name: p.name.text, type: ty });
    }

    const ret = isAsync
      ? typeNodeToRust(unwrapPromiseInnerType(m, `Method '${m.name.text}'`, m.type, "TSB4108"))
      : typeNodeToRust(m.type);
    const methodCtx: EmitCtx = {
      checker: ctx.checker,
      unions: ctx.unions,
      structs: ctx.structs,
      traitsByKey: ctx.traitsByKey,
      traitsByName: ctx.traitsByName,
      shapeStructsByKey: ctx.shapeStructsByKey,
      shapeStructsByFile: ctx.shapeStructsByFile,
      kernelDeclBySymbol: ctx.kernelDeclBySymbol,
      gpuRuntime: ctx.gpuRuntime,
      generatedNameCounters: ctx.generatedNameCounters,
      thisName: "self",
      inAsync: isAsync,
    };
    const body: RustStmt[] = [...lowerDefaultParamPrelude(methodCtx, defaulted)];
    for (const st of m.body!.statements) body.push(...lowerStmt(methodCtx, st));

    implItems.push({
      kind: "fn",
      span: spanFromNode(m),
      vis,
      async: isAsync,
      typeParams: methodTypeParams,
      receiver,
      name: m.name.text,
      params,
      ret,
      attrs: [],
      body,
    });

    classMethodsByName.set(m.name.text, {
      receiver: { mut: receiver.mut, lifetime: receiver.lifetime },
      typeParams: methodTypeParams,
      params,
      ret,
      body,
      span: spanFromNode(m),
      async: isAsync,
    });
  }

  const implItem: RustItem = {
    kind: "impl",
    span: classSpan,
    typeParams: classTypeParams,
    typePath: classTypePath,
    items: implItems,
  };

  const traitImpls: RustItem[] = [];
  for (const imp of implementsTraits) {
    const traitDefForPath = (path: RustType): TraitDef | undefined => {
      if (path.kind !== "path") return undefined;
      const segs = path.path.segments;
      const traitName = segs.length > 0 ? segs[segs.length - 1]! : undefined;
      if (!traitName) return undefined;
      const candidates = [...(ctx.traitsByName.get(traitName) ?? [])].sort((a, b) => compareText(a.key, b.key));
      return candidates.find((t) => t.typeParams.length === path.args.length);
    };

    const traitTypeKey = (type: RustType): string => {
      switch (type.kind) {
        case "unit":
          return "()";
        case "ref":
          return `&${type.mut ? "mut " : ""}${type.lifetime ? `'${type.lifetime} ` : ""}${traitTypeKey(type.inner)}`;
        case "slice":
          return `[${traitTypeKey(type.inner)}]`;
        case "array":
          return `[${traitTypeKey(type.inner)};${type.len}]`;
        case "tuple":
          return `(${type.elems.map((e) => traitTypeKey(e)).join(",")})`;
        case "path":
          return `${type.path.segments.join("::")}<${type.args.map((a) => traitTypeKey(a)).join(",")}>`;
      }
    };

    const queue: RustType[] = [imp.traitPath];
    const seenTraitKeys = new Set<string>();
    const requirements: { readonly path: RustType; readonly def: TraitDef }[] = [];

    while (queue.length > 0) {
      const nextPath = queue.shift()!;
      if (nextPath.kind !== "path") continue;
      const key = traitTypeKey(nextPath);
      if (seenTraitKeys.has(key)) continue;
      seenTraitKeys.add(key);

      const nextDef = traitDefForPath(nextPath);
      if (!nextDef) continue;

      requirements.push({ path: nextPath, def: nextDef });

      const traitTypeSubst = new Map<string, RustType>();
      for (let i = 0; i < nextDef.typeParams.length; i++) {
        const traitParam = nextDef.typeParams[i]!;
        const traitArg = nextPath.args[i];
        if (traitArg) traitTypeSubst.set(traitParam.name, traitArg);
      }
      for (const superTrait of nextDef.superTraits) {
        queue.push(substituteRustType(superTrait, traitTypeSubst));
      }
    }

    for (const requirement of requirements) {
      const traitDef = requirement.def;
      const traitPath = requirement.path;

      const traitTypeSubst = new Map<string, RustType>();
      if (traitPath.kind === "path") {
        for (let i = 0; i < traitDef.typeParams.length; i++) {
          const traitParam = traitDef.typeParams[i]!;
          const traitArg = traitPath.args[i];
          if (traitArg) traitTypeSubst.set(traitParam.name, traitArg);
        }
      }

      const traitItems: RustItem[] = [];
      for (const req of traitDef.methods) {
        const got = classMethodsByName.get(req.name);
        if (!got) {
          failAt(
            imp.node,
            "TSB4006",
            `Class '${className}' does not implement required trait method '${req.name}' from '${traitDef.name}'.`
          );
        }
        if (got.async) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' in '${traitDef.name}' cannot be implemented by an async class method in v0.`
          );
        }
        if (got.receiver.mut !== req.receiver.mut || got.receiver.lifetime !== req.receiver.lifetime) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' receiver mismatch for '${traitDef.name}'.`
          );
        }

        const methodScopeSubst = new Map(traitTypeSubst);
        for (const tp of req.typeParams) methodScopeSubst.delete(tp.name);
        const reqTypeParams = req.typeParams.map((tp) => ({
          ...tp,
          bounds: tp.bounds.map((b) => substituteRustType(b, methodScopeSubst)),
        }));
        const reqParams = req.params.map((p) => ({
          ...p,
          type: substituteRustType(p.type, methodScopeSubst),
        }));
        const reqRet = substituteRustType(req.ret, methodScopeSubst);

        if (got.typeParams.length !== reqTypeParams.length) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' generic arity mismatch for '${traitDef.name}'.`
          );
        }
        for (let i = 0; i < got.typeParams.length; i++) {
          const g = got.typeParams[i]!;
          const r = reqTypeParams[i]!;
          if (g.name !== r.name || g.bounds.length !== r.bounds.length) {
            failAt(imp.node, "TSB4007", `Trait method '${req.name}' generic constraint mismatch for '${traitDef.name}'.`);
          }
          for (let j = 0; j < g.bounds.length; j++) {
            if (!rustTypeEq(g.bounds[j]!, r.bounds[j]!)) {
              failAt(imp.node, "TSB4007", `Trait method '${req.name}' generic constraint mismatch for '${traitDef.name}'.`);
            }
          }
        }
        if (got.params.length !== reqParams.length) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' parameter arity mismatch for '${traitDef.name}'.`
          );
        }
        for (let i = 0; i < got.params.length; i++) {
          const gp = got.params[i]!;
          const rp = reqParams[i]!;
          if (gp.name !== rp.name || !rustTypeEq(gp.type, rp.type)) {
            failAt(imp.node, "TSB4007", `Trait method '${req.name}' parameter mismatch for '${traitDef.name}'.`);
          }
        }
        if (!rustTypeEq(got.ret, reqRet)) {
          failAt(imp.node, "TSB4007", `Trait method '${req.name}' return type mismatch for '${traitDef.name}'.`);
        }

        traitItems.push({
          kind: "fn",
          span: got.span,
          vis: "private",
          async: false,
          typeParams: got.typeParams,
          receiver: { kind: "ref_self", mut: got.receiver.mut, lifetime: got.receiver.lifetime },
          name: req.name,
          params: got.params,
          ret: got.ret,
          attrs: [],
          body: got.body,
        });
      }

      traitImpls.push({
        kind: "impl",
        span: classSpan,
        typeParams: classTypeParams,
        traitPath,
        typePath: classTypePath,
        items: traitItems,
      });
    }
  }

  return [structItem, ...traitImpls, implItem];
}

function tryParseDiscriminatedUnionTypeAlias(decl: ts.TypeAliasDeclaration): UnionDef | undefined {
  const name = decl.name.text;
  const ty = decl.type;
  if (!ts.isUnionTypeNode(ty)) return undefined;

  if (ty.types.length < 2) {
    failAt(decl, "TSB5000", `Discriminated unions must have at least 2 variants: ${name}.`);
  }

  const variants: { readonly tag: string; readonly node: ts.TypeLiteralNode }[] = [];
  const propertyNamesByVariant: string[][] = [];

  for (const t of ty.types) {
    if (!ts.isTypeLiteralNode(t)) {
      failAt(t, "TSB5001", `Discriminated union variants must be object types in v0: ${name}.`);
    }
    const propNames: string[] = [];
    for (const m of t.members) {
      if (!ts.isPropertySignature(m)) {
        failAt(m, "TSB5002", `Only property signatures are supported in union variants in v0: ${name}.`);
      }
      if (!ts.isIdentifier(m.name)) {
        failAt(m.name, "TSB5003", `Only identifier-named properties are supported in union variants in v0: ${name}.`);
      }
      propNames.push(m.name.text);
    }
    propertyNamesByVariant.push(propNames);
    variants.push({ tag: "__pending__", node: t });
  }

  const common = propertyNamesByVariant.reduce<Set<string>>((acc, names) => {
    const set = new Set(names);
    if (!acc) return set;
    for (const k of [...acc]) if (!set.has(k)) acc.delete(k);
    return acc;
  }, new Set(propertyNamesByVariant[0] ?? []));

  const candidates: string[] = [];
  for (const k of common) {
    let ok = true;
    for (const v of variants) {
      const prop = v.node.members.find((m) => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === k) as
        | ts.PropertySignature
        | undefined;
      if (!prop || !prop.type || !ts.isLiteralTypeNode(prop.type) || !ts.isStringLiteral(prop.type.literal)) {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push(k);
  }

  if (candidates.length !== 1) {
    failAt(
      decl,
      "TSB5004",
      `Could not determine discriminant property for union '${name}' (candidates: ${candidates.length === 0 ? "none" : candidates.join(", ")}).`
    );
  }
  const discriminant = candidates[0]!;

  const unionVariants: UnionVariantDef[] = [];
  const usedVariantNames = new Set<string>();
  const usedTags = new Set<string>();

  for (const v of variants) {
    const tagProp = v.node.members.find(
      (m) => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === discriminant
    ) as ts.PropertySignature | undefined;
    if (!tagProp || !tagProp.type || !ts.isLiteralTypeNode(tagProp.type) || !ts.isStringLiteral(tagProp.type.literal)) {
      failAt(v.node, "TSB5005", `Union '${name}' is missing a '${discriminant}' string-literal discriminant.`);
    }
    const tag = tagProp.type.literal.text;
    if (usedTags.has(tag)) failAt(tagProp.type.literal, "TSB5006", `Duplicate union tag '${tag}' in ${name}.`);
    usedTags.add(tag);

    const variantName = rustTypeNameFromTag(tag);
    if (usedVariantNames.has(variantName)) {
      failAt(decl, "TSB5007", `Two union tags map to the same Rust variant name '${variantName}' in ${name}.`);
    }
    usedVariantNames.add(variantName);

    const fields: { name: string; type: RustType }[] = [];
    for (const m of v.node.members) {
      if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name)) continue;
      const propName = m.name.text;
      if (propName === discriminant) continue;
      if (!m.type) {
        failAt(m, "TSB5008", `Union variant field '${propName}' in ${name} must have a type annotation in v0.`);
      }
      if (m.questionToken) {
        failAt(m, "TSB5009", `Optional union fields are not supported in v0 (use Option<T>): ${name}.${propName}`);
      }
      fields.push({ name: propName, type: typeNodeToRust(m.type) });
    }

    unionVariants.push({ tag, name: variantName, fields });
  }

  return { key: unionKeyFromDecl(decl), name, discriminant, variants: unionVariants };
}

function tryParseStructTypeAlias(decl: ts.TypeAliasDeclaration): StructDef | undefined {
  const ty = decl.type;
  if (!ts.isTypeLiteralNode(ty)) return undefined;

  const fields: { readonly name: string; readonly type: RustType }[] = [];
  const seen = new Set<string>();
  for (const m of ty.members) {
    if (!ts.isPropertySignature(m)) {
      failAt(m, "TSB5200", `Only property signatures are supported in object type aliases in v0: ${decl.name.text}.`);
    }
    if (!ts.isIdentifier(m.name)) {
      failAt(m.name, "TSB5201", `Only identifier-named properties are supported in object type aliases in v0: ${decl.name.text}.`);
    }
    if (!m.type) {
      failAt(m, "TSB5202", `Type alias field '${m.name.text}' in ${decl.name.text} must have a type annotation in v0.`);
    }
    if (m.questionToken) {
      failAt(m, "TSB5203", `Optional fields are not supported in object type aliases in v0 (use Option<T>): ${decl.name.text}.${m.name.text}`);
    }
    const name = m.name.text;
    if (seen.has(name)) failAt(m.name, "TSB5204", `Duplicate field '${name}' in ${decl.name.text}.`);
    seen.add(name);
    fields.push({ name, type: typeNodeToRust(m.type) });
  }

  const key = unionKeyFromDecl(decl);
  const vis: "pub" | "private" = hasModifier(decl, ts.SyntaxKind.ExportKeyword) ? "pub" : "private";

  return { key, name: decl.name.text, span: spanFromNode(decl), vis, fields };
}

function structItemFromDef(def: StructDef, attrs: readonly string[]): RustItem {
  const fieldVis: RustVisibility = def.vis === "pub" ? "pub" : "private";
  return {
    kind: "struct",
    span: def.span,
    vis: def.vis,
    name: def.name,
    typeParams: [],
    attrs,
    fields: def.fields.map((f) => ({ vis: fieldVis, name: f.name, type: f.type })),
  };
}

function lowerPlainTypeAlias(ctx: EmitCtx, decl: ts.TypeAliasDeclaration, attrs: readonly string[]): RustItem {
  const owner = `Type alias '${decl.name.text}'`;
  for (const p of decl.typeParameters ?? []) {
    if (p.default) {
      failAt(p.default, "TSB5205", `${owner}: default generic type arguments are not supported in v0.`);
    }
  }
  const typeParams = lowerTypeParameters(ctx.checker, decl, owner, decl.typeParameters, "TSB5205");
  let target: RustType;
  try {
    target = typeNodeToRust(decl.type);
  } catch (error) {
    if (error instanceof CompileError && error.code === "TSB1010") {
      failAt(
        decl.type,
        "TSB5206",
        `${owner}: unsupported type-level construct in v0 (use nominal/struct/union-compatible forms).`
      );
    }
    throw error;
  }
  return {
    kind: "type_alias",
    span: spanFromNode(decl),
    vis: hasModifier(decl, ts.SyntaxKind.ExportKeyword) ? "pub" : "private",
    name: decl.name.text,
    typeParams,
    attrs,
    target,
  };
}

function lowerTypeAlias(ctx: EmitCtx, decl: ts.TypeAliasDeclaration, attrs: readonly string[]): readonly RustItem[] {
  const key = unionKeyFromDecl(decl);
  const unionDef = ctx.unions.get(key);
  if (unionDef) {
    return [
      {
        kind: "enum",
        span: spanFromNode(decl),
        vis: hasModifier(decl, ts.SyntaxKind.ExportKeyword) ? "pub" : "private",
        name: unionDef.name,
        attrs,
        variants: unionDef.variants.map((v) => ({
          name: v.name,
          fields: v.fields,
        })),
      },
    ];
  }

  const structDef = ctx.structs.get(key);
  if (structDef) return [structItemFromDef(structDef, attrs)];

  return [lowerPlainTypeAlias(ctx, decl, attrs)];
}

function parseInterfaceMethod(
  checker: ts.TypeChecker,
  decl: ts.InterfaceDeclaration,
  member: ts.TypeElement
): TraitMethodDef {
  if (!ts.isMethodSignature(member)) {
    failAt(member, "TSB5102", `Only method signatures are supported in interfaces in v0: ${decl.name.text}.`);
  }
  if (!ts.isIdentifier(member.name)) {
    failAt(member.name, "TSB5103", `Only identifier-named interface methods are supported in v0: ${decl.name.text}.`);
  }
  if (member.questionToken) {
    failAt(member, "TSB5104", `Optional interface methods are not supported in v0: ${decl.name.text}.${member.name.text}.`);
  }
  const owner = `Interface '${decl.name.text}' method '${member.name.text}'`;
  const typeParams = lowerTypeParameters(checker, member, owner, member.typeParameters, "TSB5105");

  const [first, ...rest] = member.parameters;
  if (!first || !ts.isIdentifier(first.name) || first.name.text !== "this") {
    failAt(member, "TSB5106", `${owner}: first parameter must be 'this: ref<this>' or 'this: mutref<this>' in v0.`);
  }
  const rec = methodReceiverFromThisParam(first.type);
  if (!rec) {
    failAt(first, "TSB5106", `${owner}: first parameter must be 'this: ref<this>' or 'this: mutref<this>' in v0.`);
  }

  const params: RustParam[] = [];
  for (const p of rest) {
    if (!ts.isIdentifier(p.name)) {
      failAt(p.name, "TSB5107", `${owner}: destructuring parameters are not supported in v0.`);
    }
    if (!p.type) {
      failAt(p, "TSB5108", `${owner}: parameter '${p.name.text}' must have a type annotation in v0.`);
    }
    if (p.questionToken) {
      failAt(p, "TSB5109", `${owner}: optional params are not supported in v0.`);
    }
    params.push({ name: p.name.text, type: typeNodeToRust(p.type) });
  }

  if (!member.type) {
    failAt(member, "TSB5110", `${owner}: return type annotations are required in v0.`);
  }

  return {
    name: member.name.text,
    span: spanFromNode(member),
    receiver: rec,
    typeParams,
    params,
    ret: typeNodeToRust(member.type),
  };
}

function parseTraitDef(checker: ts.TypeChecker, decl: ts.InterfaceDeclaration): TraitDef {
  const key = traitKeyFromDecl(decl);
  const vis: "pub" | "private" = hasModifier(decl, ts.SyntaxKind.ExportKeyword) ? "pub" : "private";
  const typeParams = lowerTypeParameters(
    checker,
    decl,
    `Interface '${decl.name.text}'`,
    decl.typeParameters,
    "TSB5100"
  );

  const superTraits: RustType[] = [];
  for (const h of decl.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) {
      failAt(h, "TSB5101", `Unsupported interface heritage in v0: ${decl.name.text}.`);
    }
    for (const t0 of h.types) {
      if (!ts.isExpressionWithTypeArguments(t0)) {
        failAt(t0, "TSB5101", `Unsupported interface extends clause in v0: ${decl.name.text}.`);
      }
      superTraits.push(lowerExprWithTypeArgsToRustType(`Interface '${decl.name.text}'`, t0, "TSB5101"));
    }
  }

  const methods = decl.members.map((m) => parseInterfaceMethod(checker, decl, m));
  return { key, name: decl.name.text, span: spanFromNode(decl), vis, typeParams, superTraits, methods };
}

function lowerTraitDef(def: TraitDef): RustItem {
  return {
    kind: "trait",
    span: def.span,
    vis: def.vis,
    name: def.name,
    typeParams: def.typeParams,
    superTraits: def.superTraits,
    items: def.methods.map((m) => ({
      kind: "fn",
      span: m.span,
      vis: "private",
      async: false,
      typeParams: m.typeParams,
      receiver: { kind: "ref_self", mut: m.receiver.mut, lifetime: m.receiver.lifetime },
      name: m.name,
      params: m.params,
      ret: m.ret,
      attrs: [],
    })),
  };
}

function lowerInterface(ctx: EmitCtx, decl: ts.InterfaceDeclaration): readonly RustItem[] {
  const def = ctx.traitsByKey.get(traitKeyFromDecl(decl)) ?? parseTraitDef(ctx.checker, decl);
  return [lowerTraitDef(def)];
}

export function compileHostToRust(opts: CompileHostOptions): CompileHostOutput {
  const spanMapper = createSpanFileNameMapper(opts.entryFile);
  return withSpanFileNameMapper(spanMapper, () => compileHostToRustImpl(opts));
}

function compileHostToRustImpl(opts: CompileHostOptions): CompileHostOutput {
  // Phase 1: bootstrap TypeScript program + entry contract checks.
  const bootstrap = runBootstrapPass(opts, {
    fail,
    failAt,
    getExportedMain,
    hasModifier,
    unwrapPromiseInnerType,
    typeNodeToRust,
    isInNodeModules,
    syntheticSpanForFile,
    mapSpanFileName,
  });
  const {
    checker,
    entrySourceFile: sf,
    mainFn,
    runtimeKind,
    mainIsAsync,
    returnKind,
    rustReturnType,
    userSourceFiles,
  } = bootstrap;

  // Phase 2: initialize compiler context and crate dependency accumulator.
  const ctx = createEmitCtx(checker);
  const usedCratesByName = new Map<string, CrateDep>();

  if (mainIsAsync && runtimeKind === "tokio") {
    addUsedCrate(usedCratesByName, mainFn, {
      name: "tokio",
      version: "1.37",
      features: ["macros", "rt-multi-thread"],
    });
  }

  // Phase 3: collect kernel declarations + user module index.
  const kernels = collectSortedKernelDecls(ctx, userSourceFiles);

  const items: RustItem[] = [];

  const entryFileName = normalizePath(sf.fileName);
  const { userFilesByName, moduleNameByFile } = createUserModuleIndexPass(userSourceFiles, entryFileName, {
    normalizePath,
    rustModuleNameFromFileName,
    failAt,
  });

  // Phase 4: lower file top-level declarations/imports to typed IR buckets.
  const loweredByFile = collectFileLoweringsPass(
    userSourceFiles,
    entryFileName,
    userFilesByName,
    moduleNameByFile,
    {
      normalizePath,
      failAt,
      isMarkerModuleSpecifier,
      hasModifier,
      tryParseAnnotateStatement: (statement) => tryParseAnnotateStatement(ctx, statement),
      isKernelImportIdentifier: (identifier) => Boolean(kernelDeclForIdentifier(ctx, identifier)),
      isKernelInitializer: (initializer) =>
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === "kernel" &&
        isFromTsubaGpuLang(ctx, initializer.expression),
      resolveRelativeImport: (atNode, fromFileName, spec, users, mods) =>
        resolveRelativeImportPass(atNode, fromFileName, spec, users, mods, {
          normalizePath,
          rustModuleNameFromFileName,
          failAt,
        }),
      packageNameFromSpecifier,
      findNodeModulesPackageRoot,
      readBindingsManifest,
      addUsedCrate: (atNode, dep) => addUsedCrate(usedCratesByName, atNode, dep),
      splitRustPath,
      spanFromNode,
    }
  );

  // Phase 5: build typed HIR modules from lowered source buckets.
  const hirByFile = buildHirModulesPass(loweredByFile);

  // Phase 6: pre-collect cross-file type models (unions/struct aliases/traits).
  collectTypeModelsPass(hirByFile, {
    onTypeAlias: (decl) => {
      const unionDef = tryParseDiscriminatedUnionTypeAlias(decl);
      if (unionDef) ctx.unions.set(unionDef.key, unionDef);

      const structDef = tryParseStructTypeAlias(decl);
      if (structDef) ctx.structs.set(structDef.key, structDef);
    },
    onInterface: (decl) => {
      const traitDef = parseTraitDef(checker, decl);
      ctx.traitsByKey.set(traitDef.key, traitDef);
      const existing = ctx.traitsByName.get(traitDef.name) ?? [];
      existing.push(traitDef);
      ctx.traitsByName.set(traitDef.name, existing);
    },
  });

  // Phase 7: collect `annotate(...)` markers and validate declaration ordering.
  const attrsByFile = collectAnnotationsPass(hirByFile, entryFileName, mainFn, {
    failAt,
    unionKeyFromDecl,
    hasUnionDef: (key) => ctx.unions.has(key),
    hasStructDef: (key) => ctx.structs.has(key),
  });

  // Phase 8: emit module + root declarations into Rust IR in deterministic order.
  const declarationPhase = emitModuleAndRootDeclarationsPass(
    ctx,
    sf,
    entryFileName,
    hirByFile,
    moduleNameByFile,
    attrsByFile,
    {
      failAt,
      compareText,
      sortUseItems,
      lowerTypeAlias,
      lowerInterface,
      lowerClass,
      lowerFunction,
      getShapeStructsByFile: (fileName) => ctx.shapeStructsByFile.get(fileName) ?? [],
      structItemFromDef,
    }
  );
  items.push(...declarationPhase.items);

  // Phase 9: lower entry main body + root shape structs and finalize Rust program text.
  const mainItems = emitMainAndRootShapesPass(
    {
      ctx,
      mainFn,
      mainIsAsync,
      runtimeKind,
      returnKind,
      rustReturnType,
      rootAttrs: declarationPhase.rootAttrs,
      entryFileName,
    },
    {
      compareText,
      lowerStmt,
      getShapeStructsByFile: (fileName) => ctx.shapeStructsByFile.get(fileName) ?? [],
      structItemFromDef,
      spanFromNode,
      unitType,
    }
  );
  items.push(...mainItems);

  const rustProgram: RustProgram = { kind: "program", items };
  let mainRs = writeRustProgram(rustProgram, { header: ["// Generated by @tsuba/compiler (v0)"] });
  if (ctx.gpuRuntime.used) {
    mainRs = `${mainRs}\n${renderCudaRuntimeModule(kernels)}\n`;
  }

  const crates = [...usedCratesByName.values()].sort((a, b) => compareText(a.name, b.name));
  return { mainRs, kernels, crates };
}
