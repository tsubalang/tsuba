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
import { writeRustProgram } from "./write.js";

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

type MainReturnKind = "unit" | "result";

type CompileBootstrap = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly entrySourceFile: ts.SourceFile;
  readonly mainFn: ts.FunctionDeclaration;
  readonly runtimeKind: "none" | "tokio";
  readonly mainIsAsync: boolean;
  readonly returnKind: MainReturnKind;
  readonly rustReturnType?: RustType;
  readonly userSourceFiles: readonly ts.SourceFile[];
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

function entityNameToSegments(name: ts.EntityName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return [...entityNameToSegments(name.left), name.right.text];
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
    fileName: normalizePath(sf.fileName),
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
  const sym0 = ctx.checker.getSymbolAtLocation(ident);
  const sym =
    sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
  if (!sym) return undefined;
  return ctx.kernelDeclBySymbol.get(sym);
}

export type KernelDecl = {
  readonly name: string;
  readonly specText: string;
  readonly cuSource: string;
  readonly params: readonly KernelParamSig[];
};

export type KernelScalar = "i32" | "u32" | "f32" | "f64" | "bool";

export type KernelParamSig =
  | { readonly name: string; readonly kind: "scalar"; readonly scalar: KernelScalar }
  | { readonly name: string; readonly kind: "global_ptr"; readonly scalar: KernelScalar };

type CudaType =
  | { readonly kind: "scalar"; readonly scalar: KernelScalar }
  | { readonly kind: "ptr"; readonly addrSpace: "global" | "shared"; readonly inner: KernelScalar };

function cudaTypeFromTypeNode(node: ts.TypeNode, at: ts.Node): CudaType {
  if (node.kind === ts.SyntaxKind.VoidKeyword) {
    failAt(at, "TSB1410", "Kernel types must not be void (except return type).");
  }
  if (!ts.isTypeReferenceNode(node)) {
    failAt(node, "TSB1410", `Unsupported kernel type annotation in v0: ${node.getText()}`);
  }
  const tn = node.typeName;
  if (!ts.isIdentifier(tn)) {
    failAt(tn, "TSB1410", `Unsupported kernel type annotation in v0: ${node.getText()}`);
  }

  const scalar = (() => {
    switch (tn.text) {
      case "i32":
      case "u32":
      case "f32":
      case "f64":
      case "bool":
        return tn.text as KernelScalar;
      default:
        return undefined;
    }
  })();
  if (scalar) {
    if ((node.typeArguments?.length ?? 0) > 0) {
      failAt(node, "TSB1411", `Scalar kernel type must not have type arguments: ${node.getText()}`);
    }
    return { kind: "scalar", scalar };
  }

  if (tn.text === "global_ptr") {
    const args = node.typeArguments ?? [];
    if (args.length !== 1) {
      failAt(node, "TSB1412", `global_ptr<T> must have exactly one type argument in v0 (got ${node.getText()}).`);
    }
    const inner = cudaTypeFromTypeNode(args[0]!, args[0]!);
    if (inner.kind !== "scalar") {
      failAt(args[0]!, "TSB1413", `global_ptr<T> inner type must be a scalar in v0 (got ${args[0]!.getText()}).`);
    }
    return { kind: "ptr", addrSpace: "global", inner: inner.scalar };
  }

  if (tn.text === "shared_ptr") {
    const args = node.typeArguments ?? [];
    if (args.length !== 1) {
      failAt(node, "TSB1417", `shared_ptr<T> must have exactly one type argument in v0 (got ${node.getText()}).`);
    }
    const inner = cudaTypeFromTypeNode(args[0]!, args[0]!);
    if (inner.kind !== "scalar") {
      failAt(args[0]!, "TSB1418", `shared_ptr<T> inner type must be a scalar in v0 (got ${args[0]!.getText()}).`);
    }
    return { kind: "ptr", addrSpace: "shared", inner: inner.scalar };
  }

  failAt(node, "TSB1410", `Unsupported kernel type annotation in v0: ${node.getText()}`);
}

function cudaScalarToCType(s: KernelScalar): string {
  switch (s) {
    case "i32":
      return "int32_t";
    case "u32":
      return "uint32_t";
    case "f32":
      return "float";
    case "f64":
      return "double";
    case "bool":
      return "bool";
  }
}

function cudaTypeToCType(t: CudaType): string {
  switch (t.kind) {
    case "scalar":
      return cudaScalarToCType(t.scalar);
    case "ptr":
      return `${cudaScalarToCType(t.inner)}*`;
  }
}

type CudaEnv = {
  readonly vars: Map<string, CudaType>;
  readonly sharedDecls: string[];
  nextSharedId: number;
};

function lowerKernelExprToCuda(env: CudaEnv, expr: ts.Expression): { readonly text: string; readonly type: CudaType } {
  if (ts.isParenthesizedExpression(expr)) {
    const inner = lowerKernelExprToCuda(env, expr.expression);
    return { text: `(${inner.text})`, type: inner.type };
  }

  if (ts.isIdentifier(expr)) {
    const t = env.vars.get(expr.text);
    if (!t) failAt(expr, "TSB1420", `Unknown kernel identifier '${expr.text}'.`);
    return { text: expr.text, type: t };
  }

  if (ts.isAsExpression(expr)) {
    const castTy = cudaTypeFromTypeNode(expr.type, expr.type);
    if (castTy.kind !== "scalar") {
      failAt(expr.type, "TSB1423", `Only scalar casts are supported in kernel code in v0 (got ${expr.type.getText()}).`);
    }
    const innerText = (() => {
      if (ts.isNumericLiteral(expr.expression)) return expr.expression.text;
      const inner = lowerKernelExprToCuda(env, expr.expression);
      if (inner.type.kind !== "scalar") {
        failAt(expr.expression, "TSB1424", "Pointer casts are not supported in kernel code in v0.");
      }
      return inner.text;
    })();
    const cTy = cudaScalarToCType(castTy.scalar);
    return { text: `((${cTy})(${innerText}))`, type: castTy };
  }

  if (ts.isNumericLiteral(expr)) {
    failAt(
      expr,
      "TSB1421",
      "Numeric literals in kernels must be explicitly cast in v0 (e.g., 1 as u32, 0.0 as f32)."
    );
  }
  if (ts.isStringLiteral(expr)) {
    failAt(expr, "TSB1422", "String literals are not supported in kernel code in v0.");
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return { text: "true", type: { kind: "scalar", scalar: "bool" } };
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return { text: "false", type: { kind: "scalar", scalar: "bool" } };
  }

  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const name = expr.expression.text;

    if (name === "sharedArray") {
      if ((expr.arguments?.length ?? 0) !== 0) {
        failAt(expr, "TSB1436", "sharedArray<T,N>() in kernel code must have 0 args in v0.");
      }
      const args = expr.typeArguments ?? [];
      if (args.length !== 2) {
        failAt(expr, "TSB1437", `sharedArray<T,N>() must have exactly 2 type arguments in v0 (got ${expr.getText()}).`);
      }
      const elTy = cudaTypeFromTypeNode(args[0]!, args[0]!);
      if (elTy.kind !== "scalar") {
        failAt(args[0]!, "TSB1438", `sharedArray<T,N>() element type must be a scalar in v0 (got ${args[0]!.getText()}).`);
      }
      const lenTy = args[1]!;
      if (!ts.isLiteralTypeNode(lenTy) || !ts.isNumericLiteral(lenTy.literal)) {
        failAt(lenTy, "TSB1439", `sharedArray<T,N>() length must be a numeric literal type in v0 (got ${lenTy.getText()}).`);
      }
      const len = Number.parseInt(lenTy.literal.text, 10);
      if (!Number.isFinite(len) || len <= 0) {
        failAt(lenTy.literal, "TSB1439", `sharedArray<T,N>() length must be a positive integer literal in v0 (got ${lenTy.literal.getText()}).`);
      }

      const sharedName = `__tsuba_smem${env.nextSharedId++}`;
      env.sharedDecls.push(`__shared__ ${cudaScalarToCType(elTy.scalar)} ${sharedName}[${lenTy.literal.text}];`);
      return { text: sharedName, type: { kind: "ptr", addrSpace: "shared", inner: elTy.scalar } };
    }

    if (name === "addr") {
      if ((expr.typeArguments?.length ?? 0) !== 0) {
        failAt(expr, "TSB1425", "addr(ptr, index) in kernel code must not have type arguments in v0.");
      }
      if (expr.arguments.length !== 2) {
        failAt(expr, "TSB1425", "addr(ptr, index) in kernel code must have exactly 2 args in v0.");
      }
      const base = lowerKernelExprToCuda(env, expr.arguments[0]!);
      if (base.type.kind !== "ptr") {
        failAt(expr.arguments[0]!, "TSB1425", "addr(ptr, index) requires ptr to be a pointer type in v0.");
      }
      const idx = lowerKernelExprToCuda(env, expr.arguments[1]!);
      if (idx.type.kind !== "scalar" || (idx.type.scalar !== "u32" && idx.type.scalar !== "i32")) {
        failAt(expr.arguments[1]!, "TSB1425", "addr(ptr, index) index must be i32 or u32 in v0.");
      }
      return { text: `(&(${base.text}[${idx.text}]))`, type: base.type };
    }

    if (name === "atomicAdd") {
      if ((expr.typeArguments?.length ?? 0) !== 0) {
        failAt(expr, "TSB1425", "atomicAdd(ptr, value) in kernel code must not have type arguments in v0.");
      }
      if (expr.arguments.length !== 2) {
        failAt(expr, "TSB1425", "atomicAdd(ptr, value) in kernel code must have exactly 2 args in v0.");
      }
      const ptr = lowerKernelExprToCuda(env, expr.arguments[0]!);
      if (ptr.type.kind !== "ptr" || ptr.type.inner !== "u32") {
        failAt(expr.arguments[0]!, "TSB1425", "atomicAdd(ptr, value) requires ptr to be global_ptr<u32> in v0.");
      }
      const value = lowerKernelExprToCuda(env, expr.arguments[1]!);
      if (value.type.kind !== "scalar" || value.type.scalar !== "u32") {
        failAt(expr.arguments[1]!, "TSB1425", "atomicAdd(ptr, value) requires value to be u32 in v0.");
      }
      return { text: `atomicAdd(${ptr.text}, ${value.text})`, type: { kind: "scalar", scalar: "u32" } };
    }

    if (name === "expf") {
      if ((expr.typeArguments?.length ?? 0) !== 0) {
        failAt(expr, "TSB1425", "expf(x) in kernel code must not have type arguments in v0.");
      }
      if (expr.arguments.length !== 1) {
        failAt(expr, "TSB1425", "expf(x) in kernel code must have exactly 1 arg in v0.");
      }
      const x = lowerKernelExprToCuda(env, expr.arguments[0]!);
      if (x.type.kind !== "scalar" || x.type.scalar !== "f32") {
        failAt(expr.arguments[0]!, "TSB1425", "expf(x) requires x to be f32 in v0.");
      }
      return { text: `expf(${x.text})`, type: { kind: "scalar", scalar: "f32" } };
    }

    if (expr.arguments.length !== 0) {
      failAt(expr, "TSB1425", `${name}(...) in kernel code is not supported in v0.`);
    }
    // Intrinsics (CUDA-like)
    switch (name) {
      case "threadIdxX":
        return { text: "((uint32_t)threadIdx.x)", type: { kind: "scalar", scalar: "u32" } };
      case "threadIdxY":
        return { text: "((uint32_t)threadIdx.y)", type: { kind: "scalar", scalar: "u32" } };
      case "threadIdxZ":
        return { text: "((uint32_t)threadIdx.z)", type: { kind: "scalar", scalar: "u32" } };
      case "blockIdxX":
        return { text: "((uint32_t)blockIdx.x)", type: { kind: "scalar", scalar: "u32" } };
      case "blockIdxY":
        return { text: "((uint32_t)blockIdx.y)", type: { kind: "scalar", scalar: "u32" } };
      case "blockIdxZ":
        return { text: "((uint32_t)blockIdx.z)", type: { kind: "scalar", scalar: "u32" } };
      case "blockDimX":
        return { text: "((uint32_t)blockDim.x)", type: { kind: "scalar", scalar: "u32" } };
      case "blockDimY":
        return { text: "((uint32_t)blockDim.y)", type: { kind: "scalar", scalar: "u32" } };
      case "blockDimZ":
        return { text: "((uint32_t)blockDim.z)", type: { kind: "scalar", scalar: "u32" } };
      case "gridDimX":
        return { text: "((uint32_t)gridDim.x)", type: { kind: "scalar", scalar: "u32" } };
      case "gridDimY":
        return { text: "((uint32_t)gridDim.y)", type: { kind: "scalar", scalar: "u32" } };
      case "gridDimZ":
        return { text: "((uint32_t)gridDim.z)", type: { kind: "scalar", scalar: "u32" } };
      default:
        failAt(expr.expression, "TSB1426", `Unsupported call in kernel code in v0: ${name}().`);
    }
  }

  if (ts.isElementAccessExpression(expr)) {
    if (!expr.argumentExpression) {
      failAt(expr, "TSB1427", "Element access in kernel code must have an index expression in v0.");
    }
    const base = lowerKernelExprToCuda(env, expr.expression);
    if (base.type.kind !== "ptr") {
      failAt(expr.expression, "TSB1428", "Element access in kernel code is only supported on pointer types in v0.");
    }
    const idx = lowerKernelExprToCuda(env, expr.argumentExpression);
    if (idx.type.kind !== "scalar" || (idx.type.scalar !== "u32" && idx.type.scalar !== "i32")) {
      failAt(expr.argumentExpression, "TSB1429", "Pointer index must be i32 or u32 in v0.");
    }
    return { text: `${base.text}[${idx.text}]`, type: { kind: "scalar", scalar: base.type.inner } };
  }

  if (ts.isBinaryExpression(expr)) {
    const left = lowerKernelExprToCuda(env, expr.left);
    const right = lowerKernelExprToCuda(env, expr.right);
    const op = expr.operatorToken.kind;

    if (left.type.kind !== "scalar" || right.type.kind !== "scalar") {
      failAt(expr, "TSB1430", "Only scalar operations are supported in kernel code in v0.");
    }

    const binText = (opText: string): string => `(${left.text} ${opText} ${right.text})`;

    switch (op) {
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken: {
        if (left.type.scalar !== right.type.scalar) {
          failAt(expr, "TSB1431", "Kernel arithmetic requires both sides to have the same scalar type in v0.");
        }
        const opText = op === ts.SyntaxKind.PlusToken ? "+" : op === ts.SyntaxKind.MinusToken ? "-" : op === ts.SyntaxKind.AsteriskToken ? "*" : "/";
        return { text: binText(opText), type: left.type };
      }
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
        if (left.type.scalar !== right.type.scalar) {
          failAt(expr, "TSB1432", "Kernel comparisons require both sides to have the same scalar type in v0.");
        }
        const opText =
          op === ts.SyntaxKind.LessThanToken
            ? "<"
            : op === ts.SyntaxKind.LessThanEqualsToken
              ? "<="
              : op === ts.SyntaxKind.GreaterThanToken
                ? ">"
                : op === ts.SyntaxKind.GreaterThanEqualsToken
                  ? ">="
                  : op === ts.SyntaxKind.EqualsEqualsEqualsToken
                    ? "=="
                    : "!=";
        return { text: binText(opText), type: { kind: "scalar", scalar: "bool" } };
      }
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken: {
        if (left.type.scalar !== "bool" || right.type.scalar !== "bool") {
          failAt(expr, "TSB1433", "Kernel boolean operators require bool operands in v0.");
        }
        const opText = op === ts.SyntaxKind.AmpersandAmpersandToken ? "&&" : "||";
        return { text: binText(opText), type: { kind: "scalar", scalar: "bool" } };
      }
      default:
        failAt(expr.operatorToken, "TSB1434", `Unsupported binary operator in kernel code in v0: ${expr.operatorToken.getText()}`);
    }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    failAt(expr, "TSB1435", "Property access is not supported in kernel code in v0.");
  }

  failAt(expr, "TSB1420", `Unsupported kernel expression in v0: ${expr.getText()}`);
}

function lowerKernelStmtToCuda(env: CudaEnv, st: ts.Statement, indent: string): string[] {
  if (ts.isVariableStatement(st)) {
    const declList = st.declarationList;
    const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
    const isLet = (declList.flags & ts.NodeFlags.Let) !== 0;
    if (!isConst && !isLet) {
      failAt(st, "TSB1440", "Kernel variable declarations must use const/let in v0.");
    }
    const out: string[] = [];
    for (const decl of declList.declarations) {
      if (!ts.isIdentifier(decl.name)) {
        failAt(decl.name, "TSB1441", "Kernel destructuring declarations are not supported in v0.");
      }
      if (!decl.initializer) {
        failAt(decl, "TSB1442", `Kernel variable '${decl.name.text}' must have an initializer in v0.`);
      }
      const init = lowerKernelExprToCuda(env, decl.initializer);
      const ty = decl.type ? cudaTypeFromTypeNode(decl.type, decl.type) : init.type;
      if (ty.kind !== init.type.kind || (ty.kind === "scalar" && init.type.kind === "scalar" && ty.scalar !== init.type.scalar)) {
        // v0: require initializer to match declared type exactly.
        failAt(decl, "TSB1443", `Kernel initializer type does not match declared type for '${decl.name.text}' in v0.`);
      }
      env.vars.set(decl.name.text, ty);
      const mut = isLet ? "" : "const ";
      out.push(`${indent}${mut}${cudaTypeToCType(ty)} ${decl.name.text} = ${init.text};`);
    }
    return out;
  }

  if (ts.isExpressionStatement(st)) {
    const e = st.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "syncthreads") {
      if ((e.typeArguments?.length ?? 0) !== 0) {
        failAt(e, "TSB1447", "syncthreads() in kernel code must not have type arguments in v0.");
      }
      if (e.arguments.length !== 0) {
        failAt(e, "TSB1447", "syncthreads() in kernel code must have 0 args in v0.");
      }
      return [`${indent}__syncthreads();`];
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = e.left;
      const right = e.right;
      if (ts.isElementAccessExpression(left) && left.argumentExpression) {
        const target = lowerKernelExprToCuda(env, left);
        const value = lowerKernelExprToCuda(env, right);
        if (target.type.kind !== "scalar") {
          failAt(left, "TSB1445", "Kernel pointer element assignment target must be a scalar element type in v0.");
        }
        if (value.type.kind !== "scalar" || value.type.scalar !== target.type.scalar) {
          failAt(right, "TSB1446", "Kernel pointer element assignment value type must match target element type in v0.");
        }
        return [`${indent}${target.text} = ${value.text};`];
      }

      if (ts.isIdentifier(left)) {
        const targetTy = env.vars.get(left.text);
        if (!targetTy) {
          failAt(left, "TSB1444", `Unknown kernel assignment target '${left.text}' in v0.`);
        }
        if (targetTy.kind !== "scalar") {
          failAt(left, "TSB1444", `Kernel scalar assignment target '${left.text}' must be a scalar in v0.`);
        }
        const value = lowerKernelExprToCuda(env, right);
        if (value.type.kind !== "scalar" || value.type.scalar !== targetTy.scalar) {
          failAt(right, "TSB1446", `Kernel scalar assignment value type must match '${left.text}' in v0.`);
        }
        return [`${indent}${left.text} = ${value.text};`];
      }

      failAt(left, "TSB1444", "Kernel assignments must be to pointer elements (p[i] = ...) or scalar variables (x = ...) in v0.");
    }
    const ex = lowerKernelExprToCuda(env, e);
    return [`${indent}${ex.text};`];
  }

  if (ts.isIfStatement(st)) {
    const cond = lowerKernelExprToCuda(env, st.expression);
    if (cond.type.kind !== "scalar" || cond.type.scalar !== "bool") {
      failAt(st.expression, "TSB1450", "Kernel if condition must be bool in v0.");
    }
    const out: string[] = [];
    out.push(`${indent}if (${cond.text}) {`);
    const thenStmts = ts.isBlock(st.thenStatement) ? st.thenStatement.statements : [st.thenStatement];
    for (const s of thenStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `));
    if (st.elseStatement) {
      out.push(`${indent}} else {`);
      const elseStmts = ts.isBlock(st.elseStatement) ? st.elseStatement.statements : [st.elseStatement];
      for (const s of elseStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `));
    }
    out.push(`${indent}}`);
    return out;
  }

  if (ts.isReturnStatement(st)) {
    if (st.expression) {
      failAt(st.expression, "TSB1451", "Kernel return expressions are not supported in v0 (void only).");
    }
    return [`${indent}return;`];
  }

  if (ts.isBlock(st)) {
    const out: string[] = [];
    out.push(`${indent}{`);
    for (const s of st.statements) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `));
    out.push(`${indent}}`);
    return out;
  }

  if (ts.isForStatement(st)) {
    if (!st.initializer || !ts.isVariableDeclarationList(st.initializer)) {
      failAt(st, "TSB1452", "Kernel for-loops must use a let initializer in v0 (for (let i = ...; ...; ...) ...).");
    }
    const declList = st.initializer;
    const isLet = (declList.flags & ts.NodeFlags.Let) !== 0;
    const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
    if (!isLet || isConst) {
      failAt(declList, "TSB1452", "Kernel for-loop initializer must be a let declaration in v0.");
    }
    if (declList.declarations.length !== 1) {
      failAt(declList, "TSB1453", "Kernel for-loop initializer must declare exactly one variable in v0.");
    }
    const decl = declList.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      failAt(decl.name, "TSB1454", "Kernel for-loop initializer name must be an identifier in v0.");
    }
    if (!decl.initializer) {
      failAt(decl, "TSB1455", "Kernel for-loop initializer must have an initializer in v0.");
    }
    const init = lowerKernelExprToCuda(env, decl.initializer);
    const ty = decl.type ? cudaTypeFromTypeNode(decl.type, decl.type) : init.type;
    if (ty.kind !== init.type.kind || (ty.kind === "scalar" && init.type.kind === "scalar" && ty.scalar !== init.type.scalar)) {
      failAt(decl, "TSB1456", `Kernel for-loop initializer type does not match declared type for '${decl.name.text}' in v0.`);
    }
    if (ty.kind !== "scalar") {
      failAt(decl, "TSB1457", "Kernel for-loop index variable must be a scalar in v0.");
    }
    env.vars.set(decl.name.text, ty);
    const initText = `${cudaTypeToCType(ty)} ${decl.name.text} = ${init.text}`;

    if (!st.condition) {
      failAt(st, "TSB1458", "Kernel for-loop must have a condition expression in v0.");
    }
    const cond = lowerKernelExprToCuda(env, st.condition);
    if (cond.type.kind !== "scalar" || cond.type.scalar !== "bool") {
      failAt(st.condition, "TSB1458", "Kernel for-loop condition must be bool in v0.");
    }

    if (!st.incrementor) {
      failAt(st, "TSB1459", "Kernel for-loop must have an incrementor expression in v0.");
    }
    const incText = (() => {
      const inc = st.incrementor!;
      if (ts.isPostfixUnaryExpression(inc) && ts.isIdentifier(inc.operand)) {
        if (inc.operator === ts.SyntaxKind.PlusPlusToken) return `${inc.operand.text}++`;
        if (inc.operator === ts.SyntaxKind.MinusMinusToken) return `${inc.operand.text}--`;
      }
      if (ts.isPrefixUnaryExpression(inc) && ts.isIdentifier(inc.operand)) {
        if (inc.operator === ts.SyntaxKind.PlusPlusToken) return `++${inc.operand.text}`;
        if (inc.operator === ts.SyntaxKind.MinusMinusToken) return `--${inc.operand.text}`;
      }
      if (ts.isBinaryExpression(inc) && inc.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(inc.left)) {
        const targetTy = env.vars.get(inc.left.text);
        if (!targetTy || targetTy.kind !== "scalar") {
          failAt(inc.left, "TSB1459", "Kernel for-loop incrementor target must be a scalar variable in v0.");
        }
        const rhs = lowerKernelExprToCuda(env, inc.right);
        if (rhs.type.kind !== "scalar" || rhs.type.scalar !== targetTy.scalar) {
          failAt(inc.right, "TSB1459", "Kernel for-loop incrementor value type must match target in v0.");
        }
        return `${inc.left.text} = ${rhs.text}`;
      }
      failAt(inc, "TSB1459", "Unsupported kernel for-loop incrementor in v0 (use i++, ++i, i = i + 1, etc).");
    })();

    const out: string[] = [];
    out.push(`${indent}for (${initText}; ${cond.text}; ${incText}) {`);
    const bodyStmts = ts.isBlock(st.statement) ? st.statement.statements : [st.statement];
    for (const s of bodyStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `));
    out.push(`${indent}}`);
    return out;
  }

  failAt(st, "TSB1460", `Unsupported kernel statement in v0: ${st.getText()}`);
}

function lowerKernelToCudaSource(
  name: string,
  fn: ts.ArrowFunction,
  specText: string
): { readonly cuSource: string; readonly params: readonly KernelParamSig[] } {
  if (fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword) {
    failAt(fn.type, "TSB1414", "Kernel function must return void in v0.");
  }

  const env: CudaEnv = { vars: new Map<string, CudaType>(), sharedDecls: [], nextSharedId: 0 };
  const params: { readonly name: string; readonly ty: CudaType }[] = [];
  for (const p of fn.parameters) {
    if (!ts.isIdentifier(p.name)) {
      failAt(p.name, "TSB1415", "Kernel parameters must be identifiers in v0.");
    }
    if (!p.type) {
      failAt(p, "TSB1416", `Kernel parameter '${p.name.text}' must have a type annotation in v0.`);
    }
    const ty = cudaTypeFromTypeNode(p.type, p.type);
    if (ty.kind === "ptr" && ty.addrSpace !== "global") {
      failAt(p.type, "TSB1419", "Kernel parameters may only use global_ptr<T> in v0.");
    }
    env.vars.set(p.name.text, ty);
    params.push({ name: p.name.text, ty });
  }

  const bodyStmts: readonly ts.Statement[] = (() => {
    if (ts.isBlock(fn.body)) return fn.body.statements;
    // Expression-bodied: treat as a single expression statement.
    return [ts.factory.createExpressionStatement(fn.body)];
  })();

  const lines: string[] = [];
  lines.push("// Generated by @tsuba/compiler (v0) — CUDA backend");
  lines.push(`// TS kernel decl: ${name}`);
  lines.push(`// Spec: ${specText}`);
  lines.push("");
  lines.push("#include <stdint.h>");
  lines.push("#include <stdbool.h>");
  lines.push("#include <math.h>");
  lines.push("");

  const sigParams = params.map((p) => `${cudaTypeToCType(p.ty)} ${p.name}`).join(", ");
  lines.push(`extern "C" __global__ void ${name}(${sigParams}) {`);
  const bodyLines: string[] = [];
  for (const st of bodyStmts) bodyLines.push(...lowerKernelStmtToCuda(env, st, "  "));
  for (const decl of env.sharedDecls) lines.push(`  ${decl}`);
  for (const line of bodyLines) lines.push(line);
  lines.push("}");
  lines.push("");
  const paramSigs: KernelParamSig[] = params.map((p) => {
    if (p.ty.kind === "scalar") return { name: p.name, kind: "scalar", scalar: p.ty.scalar };
    return { name: p.name, kind: "global_ptr", scalar: p.ty.inner };
  });
  return { cuSource: lines.join("\n"), params: paramSigs };
}

function isAsConstObjectLiteral(
  expr: ts.Expression
): expr is ts.AsExpression & { readonly expression: ts.ObjectLiteralExpression } {
  if (!ts.isAsExpression(expr)) return false;
  if (!ts.isTypeReferenceNode(expr.type)) return false;
  if (!ts.isIdentifier(expr.type.typeName)) return false;
  if (expr.type.typeName.text !== "const") return false;
  return ts.isObjectLiteralExpression(expr.expression);
}

function kernelNameFromSpec(spec: ts.ObjectLiteralExpression): { readonly name: string; readonly at: ts.Node } {
  for (const p of spec.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = (() => {
      if (ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isStringLiteral(p.name)) return p.name.text;
      return undefined;
    })();
    if (key !== "name") continue;
    if (!ts.isStringLiteral(p.initializer)) {
      failAt(p.initializer, "TSB1408", "kernel spec 'name' must be a string literal in v0.");
    }
    const name = p.initializer.text;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      failAt(p.initializer, "TSB1409", `kernel spec 'name' must be a valid identifier in v0 (got ${JSON.stringify(name)}).`);
    }
    return { name, at: p.initializer };
  }
  failAt(spec, "TSB1407", "kernel spec must include a string literal 'name' field in v0.");
}

function collectKernelDecls(ctx: EmitCtx, sf: ts.SourceFile, seen: Set<string>): readonly KernelDecl[] {
  const out: KernelDecl[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "kernel" && isFromTsubaGpuLang(ctx, node.expression)) {
        // Must be: const <name> = kernel(spec as const, (..) => ..)
        if (
          !ts.isVariableDeclaration(node.parent) ||
          node.parent.initializer !== node ||
          !ts.isIdentifier(node.parent.name) ||
          !ts.isVariableDeclarationList(node.parent.parent)
        ) {
          failAt(node, "TSB1400", "kernel(...) must appear as a const initializer: const k = kernel(...).");
        }
        const declList = node.parent.parent;
        const declStmt = declList.parent;
        if (!ts.isVariableStatement(declStmt) || declStmt.parent !== sf) {
          failAt(node, "TSB1400", "kernel(...) must be declared in a top-level const statement in v0.");
        }
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) failAt(declList, "TSB1401", "kernel(...) must be assigned to a const in v0.");

        if (node.arguments.length !== 2) {
          failAt(node, "TSB1403", "kernel(spec, fn) must have exactly 2 arguments in v0.");
        }
        const [specArg, fnArg] = node.arguments;
        if (!specArg || !isAsConstObjectLiteral(specArg)) {
          failAt(node, "TSB1404", "kernel spec must be an object literal with 'as const' in v0.");
        }
        if (!fnArg || !ts.isArrowFunction(fnArg)) {
          failAt(node, "TSB1405", "kernel fn must be an arrow function in v0.");
        }

        const kernelName = kernelNameFromSpec(specArg.expression).name;
        if (seen.has(kernelName)) failAt(node.parent.name, "TSB1402", `Duplicate kernel name '${kernelName}'.`);
        seen.add(kernelName);

        const specText = specArg.expression.getText(sf);
        const lowered = lowerKernelToCudaSource(kernelName, fnArg, specText);
        const decl: KernelDecl = { name: kernelName, specText, cuSource: lowered.cuSource, params: lowered.params };
        out.push(decl);

        const sym0 = ctx.checker.getSymbolAtLocation(node.parent.name);
        const sym =
          sym0 && (sym0.flags & ts.SymbolFlags.Alias) !== 0 ? ctx.checker.getAliasedSymbol(sym0) : sym0;
        if (!sym) {
          failAt(node.parent.name, "TSB1402", `Could not resolve kernel symbol for '${kernelName}'.`);
        }
        ctx.kernelDeclBySymbol.set(sym, decl);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return out;
}

function renderCudaRuntimeModule(kernels: readonly KernelDecl[]): string {
  const lines: string[] = [];
  lines.push("// @tsuba/gpu CUDA runtime (v0)");
  lines.push("#[allow(dead_code)]");
  lines.push("#[allow(non_snake_case)]");
  lines.push("#[allow(non_camel_case_types)]");
  lines.push("mod __tsuba_cuda {");
  lines.push("  use std::ffi::{c_void, CStr, CString};");
  lines.push("  use std::marker::PhantomData;");
  lines.push("  use std::mem::size_of;");
  lines.push("  use std::os::raw::{c_char, c_int};");
  lines.push("  use std::ptr::{null, null_mut};");
  lines.push("  use std::sync::{Mutex, OnceLock};");
  lines.push("");
  lines.push("  #[cfg(not(unix))]");
  lines.push('  compile_error!("@tsuba/gpu: CUDA runtime only supports unix targets in v0.");');
  lines.push("");
  lines.push("  #[cfg(unix)]");
  lines.push("  const RTLD_NOW: c_int = 2;");
  lines.push("");
  lines.push("  #[cfg(unix)]");
  lines.push("  #[link(name = \"dl\")]");
  lines.push("  extern \"C\" {");
  lines.push("    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;");
  lines.push("    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;");
  lines.push("    fn dlerror() -> *const c_char;");
  lines.push("  }");
  lines.push("");
  lines.push("  type CUresult = i32;");
  lines.push("  type CUdevice = i32;");
  lines.push("  type CUcontext = *mut c_void;");
  lines.push("  type CUmodule = *mut c_void;");
  lines.push("  type CUfunction = *mut c_void;");
  lines.push("  type CUstream = *mut c_void;");
  lines.push("  type CUdeviceptr = u64;");
  lines.push("");
  lines.push("  type FnCuInit = unsafe extern \"C\" fn(flags: u32) -> CUresult;");
  lines.push("  type FnCuDeviceGet = unsafe extern \"C\" fn(device: *mut CUdevice, ordinal: i32) -> CUresult;");
  lines.push("  type FnCuCtxCreate = unsafe extern \"C\" fn(pctx: *mut CUcontext, flags: u32, dev: CUdevice) -> CUresult;");
  lines.push("  type FnCuCtxDestroy = unsafe extern \"C\" fn(ctx: CUcontext) -> CUresult;");
  lines.push("  type FnCuCtxSynchronize = unsafe extern \"C\" fn() -> CUresult;");
  lines.push("  type FnCuCtxSetCurrent = unsafe extern \"C\" fn(ctx: CUcontext) -> CUresult;");
  lines.push("  type FnCuMemAlloc = unsafe extern \"C\" fn(dptr: *mut CUdeviceptr, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuMemFree = unsafe extern \"C\" fn(dptr: CUdeviceptr) -> CUresult;");
  lines.push("  type FnCuMemcpyHtoD = unsafe extern \"C\" fn(dst: CUdeviceptr, src: *const c_void, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuMemcpyDtoH = unsafe extern \"C\" fn(dst: *mut c_void, src: CUdeviceptr, bytesize: usize) -> CUresult;");
  lines.push("  type FnCuModuleLoadData = unsafe extern \"C\" fn(module: *mut CUmodule, image: *const c_void) -> CUresult;");
  lines.push("  type FnCuModuleGetFunction = unsafe extern \"C\" fn(hfunc: *mut CUfunction, module: CUmodule, name: *const c_char) -> CUresult;");
  lines.push("  type FnCuLaunchKernel = unsafe extern \"C\" fn(");
  lines.push("    f: CUfunction,");
  lines.push("    gridX: u32, gridY: u32, gridZ: u32,");
  lines.push("    blockX: u32, blockY: u32, blockZ: u32,");
  lines.push("    sharedMemBytes: u32,");
  lines.push("    hStream: CUstream,");
  lines.push("    kernelParams: *mut *mut c_void,");
  lines.push("    extra: *mut *mut c_void");
  lines.push("  ) -> CUresult;");
  lines.push("  type FnCuGetErrorName = unsafe extern \"C\" fn(error: CUresult, pStr: *mut *const c_char) -> CUresult;");
  lines.push("  type FnCuGetErrorString = unsafe extern \"C\" fn(error: CUresult, pStr: *mut *const c_char) -> CUresult;");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  struct Api {");
  lines.push("    lib: *mut c_void,");
  lines.push("    cuInit: FnCuInit,");
  lines.push("    cuDeviceGet: FnCuDeviceGet,");
  lines.push("    cuCtxCreate_v2: FnCuCtxCreate,");
  lines.push("    cuCtxDestroy_v2: FnCuCtxDestroy,");
  lines.push("    cuCtxSynchronize: FnCuCtxSynchronize,");
  lines.push("    cuCtxSetCurrent: FnCuCtxSetCurrent,");
  lines.push("    cuMemAlloc_v2: FnCuMemAlloc,");
  lines.push("    cuMemFree_v2: FnCuMemFree,");
  lines.push("    cuMemcpyHtoD_v2: FnCuMemcpyHtoD,");
  lines.push("    cuMemcpyDtoH_v2: FnCuMemcpyDtoH,");
  lines.push("    cuModuleLoadData: FnCuModuleLoadData,");
  lines.push("    cuModuleGetFunction: FnCuModuleGetFunction,");
  lines.push("    cuLaunchKernel: FnCuLaunchKernel,");
  lines.push("    cuGetErrorName: FnCuGetErrorName,");
  lines.push("    cuGetErrorString: FnCuGetErrorString,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn dl_last_error() -> String {");
  lines.push("    let p = dlerror();");
  lines.push("    if p.is_null() {");
  lines.push("      return \"<dlerror returned null>\".to_string();");
  lines.push("    }");
  lines.push("    CStr::from_ptr(p).to_string_lossy().to_string()");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_libcuda() -> *mut c_void {");
  lines.push("    for name in [\"libcuda.so.1\", \"libcuda.so\"] {");
  lines.push("      let c = CString::new(name).unwrap();");
  lines.push("      let h = dlopen(c.as_ptr(), RTLD_NOW);");
  lines.push("      if !h.is_null() {");
  lines.push("        return h;");
  lines.push("      }");
  lines.push("    }");
  lines.push("    panic!(\"@tsuba/gpu: failed to dlopen libcuda (tried libcuda.so.1, libcuda.so): {}\", dl_last_error());");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_sym(lib: *mut c_void, name: &str) -> *mut c_void {");
  lines.push("    let c = CString::new(name).unwrap();");
  lines.push("    let p = dlsym(lib, c.as_ptr());");
  lines.push("    if p.is_null() {");
  lines.push("      panic!(\"@tsuba/gpu: missing CUDA symbol {}: {}\", name, dl_last_error());");
  lines.push("    }");
  lines.push("    p");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn load_api() -> Api {");
  lines.push("    let lib = load_libcuda();");
  lines.push("    Api {");
  lines.push("      lib,");
  lines.push("      cuInit: std::mem::transmute(load_sym(lib, \"cuInit\")),");
  lines.push("      cuDeviceGet: std::mem::transmute(load_sym(lib, \"cuDeviceGet\")),");
  lines.push("      cuCtxCreate_v2: std::mem::transmute(load_sym(lib, \"cuCtxCreate_v2\")),");
  lines.push("      cuCtxDestroy_v2: std::mem::transmute(load_sym(lib, \"cuCtxDestroy_v2\")),");
  lines.push("      cuCtxSynchronize: std::mem::transmute(load_sym(lib, \"cuCtxSynchronize\")),");
  lines.push("      cuCtxSetCurrent: std::mem::transmute(load_sym(lib, \"cuCtxSetCurrent\")),");
  lines.push("      cuMemAlloc_v2: std::mem::transmute(load_sym(lib, \"cuMemAlloc_v2\")),");
  lines.push("      cuMemFree_v2: std::mem::transmute(load_sym(lib, \"cuMemFree_v2\")),");
  lines.push("      cuMemcpyHtoD_v2: std::mem::transmute(load_sym(lib, \"cuMemcpyHtoD_v2\")),");
  lines.push("      cuMemcpyDtoH_v2: std::mem::transmute(load_sym(lib, \"cuMemcpyDtoH_v2\")),");
  lines.push("      cuModuleLoadData: std::mem::transmute(load_sym(lib, \"cuModuleLoadData\")),");
  lines.push("      cuModuleGetFunction: std::mem::transmute(load_sym(lib, \"cuModuleGetFunction\")),");
  lines.push("      cuLaunchKernel: std::mem::transmute(load_sym(lib, \"cuLaunchKernel\")),");
  lines.push("      cuGetErrorName: std::mem::transmute(load_sym(lib, \"cuGetErrorName\")),");
  lines.push("      cuGetErrorString: std::mem::transmute(load_sym(lib, \"cuGetErrorString\")),");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  fn cu_error_str(api: &Api, err: CUresult) -> String {");
  lines.push("    unsafe {");
  lines.push("      let mut name_ptr: *const c_char = null();");
  lines.push("      let mut msg_ptr: *const c_char = null();");
  lines.push("      let _ = (api.cuGetErrorName)(err, &mut name_ptr);");
  lines.push("      let _ = (api.cuGetErrorString)(err, &mut msg_ptr);");
  lines.push("      let name = if name_ptr.is_null() { \"<unknown>\".to_string() } else { CStr::from_ptr(name_ptr).to_string_lossy().to_string() };");
  lines.push("      let msg = if msg_ptr.is_null() { \"<unknown>\".to_string() } else { CStr::from_ptr(msg_ptr).to_string_lossy().to_string() };");
  lines.push("      format!(\"{} ({}): {}\", name, err, msg)");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  fn check(api: &Api, res: CUresult, what: &str) {");
  lines.push("    if res == 0 { return; }");
  lines.push("    panic!(\"@tsuba/gpu: {} failed: {}\", what, cu_error_str(api, res));");
  lines.push("  }");
  lines.push("");
  lines.push("  struct State {");
  lines.push("    api: Api,");
  lines.push("    ctx: CUcontext,");
  lines.push("    lock: Mutex<()>,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe impl Send for State {}");
  lines.push("  unsafe impl Sync for State {}");
  lines.push("");
  lines.push("  static STATE: OnceLock<State> = OnceLock::new();");
  lines.push("");
  lines.push("  fn state() -> &'static State {");
  lines.push("    STATE.get_or_init(|| unsafe {");
  lines.push("      let api = load_api();");
  lines.push("      check(&api, (api.cuInit)(0), \"cuInit\");");
  lines.push("      let mut dev: CUdevice = 0;");
  lines.push("      check(&api, (api.cuDeviceGet)(&mut dev, 0), \"cuDeviceGet\");");
  lines.push("      let mut ctx: CUcontext = null_mut();");
  lines.push("      check(&api, (api.cuCtxCreate_v2)(&mut ctx, 0, dev), \"cuCtxCreate_v2\");");
  lines.push("      State { api, ctx, lock: Mutex::new(()) }");
  lines.push("    })");
  lines.push("  }");
  lines.push("");
  lines.push("  fn ensure_ctx_current(st: &State) {");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuCtxSetCurrent)(st.ctx), \"cuCtxSetCurrent\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  impl Drop for State {");
  lines.push("    fn drop(&mut self) {");
  lines.push("      unsafe {");
  lines.push("        let _ = (self.api.cuCtxDestroy_v2)(self.ctx);");
  lines.push("      }");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  pub struct DevicePtr<T> {");
  lines.push("    pub raw: CUdeviceptr,");
  lines.push("    _marker: PhantomData<T>,");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn device_malloc<T>(len: u32) -> DevicePtr<T> {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = (len as usize) * size_of::<T>();");
  lines.push("    if bytes == 0 {");
  lines.push("      return DevicePtr { raw: 0, _marker: PhantomData };");
  lines.push("    }");
  lines.push("    let mut dptr: CUdeviceptr = 0;");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemAlloc_v2)(&mut dptr, bytes), \"cuMemAlloc_v2\");");
  lines.push("    }");
  lines.push("    DevicePtr { raw: dptr, _marker: PhantomData }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn device_free<T>(ptr: DevicePtr<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    if ptr.raw == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemFree_v2)(ptr.raw), \"cuMemFree_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn memcpy_htod<T>(dst: DevicePtr<T>, src: &Vec<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = src.len() * size_of::<T>();");
  lines.push("    if bytes == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemcpyHtoD_v2)(dst.raw, src.as_ptr() as *const c_void, bytes), \"cuMemcpyHtoD_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  pub fn memcpy_dtoh<T>(dst: &mut Vec<T>, src: DevicePtr<T>) {");
  lines.push("    let st = state();");
  lines.push("    let _g = st.lock.lock().unwrap();");
  lines.push("    ensure_ctx_current(st);");
  lines.push("    let bytes = dst.len() * size_of::<T>();");
  lines.push("    if bytes == 0 { return; }");
  lines.push("    unsafe {");
  lines.push("      check(&st.api, (st.api.cuMemcpyDtoH_v2)(dst.as_mut_ptr() as *mut c_void, src.raw, bytes), \"cuMemcpyDtoH_v2\");");
  lines.push("    }");
  lines.push("  }");
  lines.push("");
  lines.push("  #[derive(Copy, Clone)]");
  lines.push("  struct KernelFn {");
  lines.push("    #[allow(dead_code)]");
  lines.push("    module: CUmodule,");
  lines.push("    func: CUfunction,");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe impl Send for KernelFn {}");
  lines.push("  unsafe impl Sync for KernelFn {}");
  lines.push("");
  lines.push("  unsafe fn load_kernel_fn(api: &Api, ptx: &str, name: &str) -> KernelFn {");
  lines.push("    let mut module: CUmodule = null_mut();");
  lines.push("    let ptx_c = CString::new(ptx).unwrap();");
  lines.push("    check(api, (api.cuModuleLoadData)(&mut module, ptx_c.as_ptr() as *const c_void), \"cuModuleLoadData\");");
  lines.push("    let mut func: CUfunction = null_mut();");
  lines.push("    let name_c = CString::new(name).unwrap();");
  lines.push("    check(api, (api.cuModuleGetFunction)(&mut func, module, name_c.as_ptr()), \"cuModuleGetFunction\");");
  lines.push("    KernelFn { module, func }");
  lines.push("  }");
  lines.push("");
  lines.push("  unsafe fn launch_kernel(api: &Api, func: CUfunction, grid_x: u32, grid_y: u32, grid_z: u32, block_x: u32, block_y: u32, block_z: u32, params: &mut [*mut c_void]) {");
  lines.push("    check(api, (api.cuLaunchKernel)(func, grid_x, grid_y, grid_z, block_x, block_y, block_z, 0, null_mut(), params.as_mut_ptr(), null_mut()), \"cuLaunchKernel\");");
  lines.push("    check(api, (api.cuCtxSynchronize)(), \"cuCtxSynchronize\");");
  lines.push("  }");

  for (const k of kernels) {
    const argList = k.params
      .map((p, idx) => {
        const rustTy = p.kind === "scalar" ? p.scalar : `DevicePtr<${p.scalar}>`;
        return `p${idx}: ${rustTy}`;
      })
      .join(", ");
    const args = argList.length === 0 ? "" : `, ${argList}`;
    lines.push("");
    lines.push(
      `  pub fn launch_${k.name}(grid_x: u32, grid_y: u32, grid_z: u32, block_x: u32, block_y: u32, block_z: u32${args}) {`
    );
    lines.push(
      `    let _ptx: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/kernels/${k.name}.ptx"));`
    );
    lines.push("    let st = state();");
    lines.push("    let _g = st.lock.lock().unwrap();");
    lines.push("    ensure_ctx_current(st);");
    lines.push("    static K: OnceLock<KernelFn> = OnceLock::new();");
    lines.push(`    let kf = K.get_or_init(|| unsafe { load_kernel_fn(&st.api, _ptx, "${k.name}") });`);
    for (let i = 0; i < k.params.length; i++) {
      const p = k.params[i]!;
      if (p.kind === "global_ptr") {
        lines.push(`    let mut a${i}: CUdeviceptr = p${i}.raw;`);
      } else {
        lines.push(`    let mut a${i}: ${p.scalar} = p${i};`);
      }
    }
    if (k.params.length === 0) {
      lines.push("    let mut params: [*mut c_void; 0] = [];");
    } else {
      const ptrs = k.params
        .map((_, i) => `(&mut a${i} as *mut _ as *mut c_void)`)
        .join(", ");
      lines.push(`    let mut params: [*mut c_void; ${k.params.length}] = [${ptrs}];`);
    }
    lines.push(
      "    unsafe { launch_kernel(&st.api, kf.func, grid_x, grid_y, grid_z, block_x, block_y, block_z, &mut params); }"
    );
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}

const rustPrimitiveTypes = new Map<string, RustType>([
  ["i8", pathType(["i8"])],
  ["i16", pathType(["i16"])],
  ["i32", pathType(["i32"])],
  ["i64", pathType(["i64"])],
  ["i128", pathType(["i128"])],
  ["isize", pathType(["isize"])],
  ["u8", pathType(["u8"])],
  ["u16", pathType(["u16"])],
  ["u32", pathType(["u32"])],
  ["u64", pathType(["u64"])],
  ["u128", pathType(["u128"])],
  ["usize", pathType(["usize"])],
  ["f32", pathType(["f32"])],
  ["f64", pathType(["f64"])],
  ["bool", pathType(["bool"])],
  ["Str", pathType(["str"])],
  ["String", pathType(["std", "string", "String"])],
]);

function fail(code: string, message: string): never {
  assertCompilerDiagnosticCode(code);
  throw new CompileError(code, message);
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
  fail("TSB1000", "Entry file must export function main().");
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

function bootstrapCompileHost(opts: CompileHostOptions): CompileBootstrap {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const program = ts.createProgram([opts.entryFile], compilerOptions, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (diagnostics.length > 0) {
    const d = diagnostics.at(0);
    if (!d) fail("TSB0002", "Compilation failed with diagnostics.");
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      fail("TSB0002", `${d.file.fileName}:${pos.line + 1}:${pos.character + 1}: ${msg}`);
    }
    fail("TSB0002", msg);
  }
  const checker = program.getTypeChecker();

  const entrySourceFile = program.getSourceFile(opts.entryFile);
  if (!entrySourceFile) fail("TSB0001", `Could not read entry file: ${opts.entryFile}`);

  const mainFn = getExportedMain(entrySourceFile);
  const runtimeKind = opts.runtimeKind ?? "none";
  const mainIsAsync = hasModifier(mainFn, ts.SyntaxKind.AsyncKeyword);
  const returnTypeNode = mainFn.type;
  const returnKind: MainReturnKind = (() => {
    if (mainIsAsync) {
      if (runtimeKind !== "tokio") {
        fail("TSB1004", "async main() requires runtime.kind='tokio' in tsuba.workspace.json.");
      }
      const inner = unwrapPromiseInnerType(mainFn, "main()", returnTypeNode, "TSB1003");
      if (inner.kind === ts.SyntaxKind.VoidKeyword) return "unit";
      if (
        ts.isTypeReferenceNode(inner) &&
        ts.isIdentifier(inner.typeName) &&
        inner.typeName.text === "Result"
      ) {
        const [okTy] = inner.typeArguments ?? [];
        if (!okTy || okTy.kind !== ts.SyntaxKind.VoidKeyword) {
          fail("TSB1003", "async main() may only return Promise<void> or Promise<Result<void, E>> in v0.");
        }
        return "result";
      }
      fail("TSB1003", "async main() may only return Promise<void> or Promise<Result<void, E>> in v0.");
    }

    if (!returnTypeNode) return "unit";
    if (returnTypeNode.kind === ts.SyntaxKind.VoidKeyword) return "unit";
    if (
      ts.isTypeReferenceNode(returnTypeNode) &&
      ts.isIdentifier(returnTypeNode.typeName) &&
      returnTypeNode.typeName.text === "Result"
    ) {
      const [okTy] = returnTypeNode.typeArguments ?? [];
      if (!okTy || okTy.kind !== ts.SyntaxKind.VoidKeyword) {
        fail("TSB1003", "main() may only return Result<void, E> in v0.");
      }
      return "result";
    }
    fail("TSB1003", "main() must return void or Result<void, E> in v0.");
  })();

  const rustReturnType = (() => {
    if (returnKind !== "result") return undefined;
    if (mainIsAsync) {
      const inner = unwrapPromiseInnerType(mainFn, "main()", returnTypeNode, "TSB1003");
      return typeNodeToRust(inner);
    }
    return typeNodeToRust(returnTypeNode);
  })();

  const userSourceFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !isInNodeModules(f.fileName));

  return {
    program,
    checker,
    entrySourceFile,
    mainFn,
    runtimeKind,
    mainIsAsync,
    returnKind,
    rustReturnType,
    userSourceFiles,
  };
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
  };
}

function normalizeCrateDep(dep: CrateDep): CrateDep {
  const features = (dep.features ?? []).filter((x): x is string => typeof x === "string");
  const unique = [...new Set(features)].sort((a, b) => a.localeCompare(b));
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
  const features = [...mergedFeatures].sort((a, b) => a.localeCompare(b));
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
    .flatMap((f) => collectKernelDecls(ctx, f, seenKernelNames))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function createUserModuleIndex(
  userSourceFiles: readonly ts.SourceFile[],
  entryFileName: string
): {
  readonly userFilesByName: ReadonlyMap<string, ts.SourceFile>;
  readonly moduleNameByFile: ReadonlyMap<string, string>;
} {
  const userFilesByName = new Map<string, ts.SourceFile>();
  for (const f of userSourceFiles) userFilesByName.set(normalizePath(f.fileName), f);

  const moduleNameByFile = new Map<string, string>();
  const fileByModuleName = new Map<string, string>();
  for (const f of userSourceFiles) {
    const fileName = normalizePath(f.fileName);
    if (fileName === entryFileName) continue;
    const modName = rustModuleNameFromFileName(f.fileName);
    const prev = fileByModuleName.get(modName);
    if (prev) {
      fail(
        "TSB3200",
        `Two files map to the same Rust module '${modName}':\n  - ${prev}\n  - ${fileName}\nRename one of the files to avoid a module collision.`
      );
    }
    fileByModuleName.set(modName, fileName);
    moduleNameByFile.set(fileName, modName);
  }

  return { userFilesByName, moduleNameByFile };
}

function resolveRelativeImport(
  fromFileName: string,
  spec: string,
  userFilesByName: ReadonlyMap<string, ts.SourceFile>,
  moduleNameByFile: ReadonlyMap<string, string>
): { readonly targetFile: string; readonly mod: string } {
  if (!spec.startsWith(".")) {
    fail("TSB3201", `Only relative imports are supported in v0 (got ${JSON.stringify(spec)}).`);
  }
  let rewritten = spec;
  if (rewritten.endsWith(".js")) rewritten = `${rewritten.slice(0, -3)}.ts`;
  if (!rewritten.endsWith(".ts")) {
    fail("TSB3202", `Import specifier must end with '.js' (source) in v0 (got ${JSON.stringify(spec)}).`);
  }

  const abs = normalizePath(resolve(dirname(fromFileName), rewritten));
  const target = userFilesByName.get(abs);
  if (!target) {
    fail("TSB3203", `Import target not found in the project: ${JSON.stringify(spec)} -> ${abs}`);
  }
  const mod = moduleNameByFile.get(abs);
  if (!mod) {
    fail("TSB3204", `Importing the entry module is not supported in v0 (got ${JSON.stringify(spec)}).`);
  }
  return { targetFile: abs, mod };
}

function sortUseItems(uses: readonly RustItem[]): RustItem[] {
  return [...uses].sort((a, b) => {
    if (a.kind !== "use" || b.kind !== "use") return 0;
    const pa = a.path.segments.join("::");
    const pb = b.path.segments.join("::");
    if (pa !== pb) return pa.localeCompare(pb);
    const aa = a.alias ?? "";
    const ab = b.alias ?? "";
    return aa.localeCompare(ab);
  });
}

function parseTokensArg(ctx: EmitCtx, expr: ts.Expression): string {
  if (!ts.isTaggedTemplateExpression(expr) || !ts.isIdentifier(expr.tag)) {
    failAt(expr, "TSB3300", "attr(...) arguments must be tokens`...` in v0.");
  }
  if (expr.tag.text !== "tokens" || !isFromTsubaCoreLang(ctx, expr.tag)) {
    failAt(expr.tag, "TSB3301", "attr(...) arguments must use @tsuba/core tokens`...` in v0.");
  }
  const tmpl = expr.template;
  if (!ts.isNoSubstitutionTemplateLiteral(tmpl)) {
    failAt(tmpl, "TSB3302", "tokens`...` must not contain substitutions in v0.");
  }
  if (tmpl.text.includes("\n") || tmpl.text.includes("\r")) {
    failAt(tmpl, "TSB3303", "tokens`...` must be single-line in v0.");
  }
  return tmpl.text;
}

function parseAttrMarker(ctx: EmitCtx, expr: ts.Expression): string {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) {
    failAt(expr, "TSB3304", "annotate(...) only supports attr(...) markers in v0.");
  }
  const callee = expr.expression;
  if (callee.text !== "attr" || !isFromTsubaCoreLang(ctx, callee)) {
    failAt(callee, "TSB3305", "annotate(...) only supports @tsuba/core attr(...) markers in v0.");
  }
  const [nameArg, ...rest] = expr.arguments;
  if (!nameArg || !ts.isStringLiteral(nameArg)) {
    failAt(expr, "TSB3306", "attr(name, ...) requires a string literal name in v0.");
  }
  const args = rest.map((item) => parseTokensArg(ctx, item));
  if (args.length === 0) return `#[${nameArg.text}]`;
  return `#[${nameArg.text}(${args.join(", ")})]`;
}

function tryParseAnnotateStatement(
  ctx: EmitCtx,
  st: ts.Statement
): { readonly target: string; readonly attrs: readonly string[] } | undefined {
  if (!ts.isExpressionStatement(st)) return undefined;
  const e = st.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
  const callee = e.expression;
  if (callee.text !== "annotate" || !isFromTsubaCoreLang(ctx, callee)) return undefined;

  if (e.arguments.length < 2) {
    failAt(e, "TSB3307", "annotate(target, ...) requires at least one attribute in v0.");
  }
  const [target, ...items] = e.arguments;
  if (!target || !ts.isIdentifier(target)) {
    failAt(e, "TSB3308", "annotate(...) target must be an identifier in v0.");
  }
  const attrs = items.map((item) => parseAttrMarker(ctx, item));
  return { target: target.text, attrs };
}

function typeNodeToRust(typeNode: ts.TypeNode | undefined): RustType {
  if (!typeNode) return unitType();
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return unitType();
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeNameSegments = entityNameToSegments(typeNode.typeName);

    if (typeNameSegments.length > 0) {
      const baseName = typeNameSegments[typeNameSegments.length - 1]!;
      const mapped = typeNameSegments.length === 1 ? rustPrimitiveTypes.get(baseName) : undefined;
      if (mapped) return mapped;

      if (typeNameSegments.length === 1 && (baseName === "ref" || baseName === "mutref")) {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1016", `${baseName}<T> must have exactly one type argument.`);
        return { kind: "ref", mut: baseName === "mutref", inner: typeNodeToRust(inner) };
      }

      if (typeNameSegments.length === 1 && (baseName === "refLt" || baseName === "mutrefLt")) {
        const [lt, inner] = typeNode.typeArguments ?? [];
        if (!lt || !inner) failAt(typeNode, "TSB1017", `${baseName}<L,T> must have exactly two type arguments.`);
        if (!ts.isLiteralTypeNode(lt) || !ts.isStringLiteral(lt.literal)) {
          failAt(lt, "TSB1018", `${baseName} lifetime must be a string literal (e.g., refLt<\"a\", T>).`);
        }
        return {
          kind: "ref",
          mut: baseName === "mutrefLt",
          lifetime: lt.literal.text,
          inner: typeNodeToRust(inner),
        };
      }

      // mut<T> marker -> let mut + T
      if (typeNameSegments.length === 1 && baseName === "mut") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1011", "mut<T> must have exactly one type argument.");
        return typeNodeToRust(inner);
      }

      if (typeNameSegments.length === 1 && baseName === "Option") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1012", "Option<T> must have exactly one type argument.");
        return pathType(["Option"], [typeNodeToRust(inner)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Result") {
        const [okTy, errTy] = typeNode.typeArguments ?? [];
        if (!okTy || !errTy) failAt(typeNode, "TSB1013", "Result<T,E> must have exactly two type arguments.");
        return pathType(["Result"], [typeNodeToRust(okTy), typeNodeToRust(errTy)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Vec") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1014", "Vec<T> must have exactly one type argument.");
        return pathType(["Vec"], [typeNodeToRust(inner)]);
      }

      if (typeNameSegments.length === 1 && baseName === "HashMap") {
        const [k, v] = typeNode.typeArguments ?? [];
        if (!k || !v) failAt(typeNode, "TSB1015", "HashMap<K,V> must have exactly two type arguments.");
        return pathType(["std", "collections", "HashMap"], [typeNodeToRust(k), typeNodeToRust(v)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Slice") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1021", "Slice<T> must have exactly one type argument.");
        return { kind: "slice", inner: typeNodeToRust(inner) };
      }

      if (typeNameSegments.length === 1 && baseName === "ArrayN") {
        const [inner, lenNode] = typeNode.typeArguments ?? [];
        if (!inner || !lenNode) {
          failAt(typeNode, "TSB1022", "ArrayN<T,N> must have exactly two type arguments.");
        }
        if (
          !ts.isLiteralTypeNode(lenNode) ||
          !ts.isNumericLiteral(lenNode.literal)
        ) {
          failAt(lenNode, "TSB1023", "ArrayN length must be a numeric literal type (e.g., ArrayN<u8, 16>).");
        }
        const len = Number.parseInt(lenNode.literal.text, 10);
        if (!Number.isInteger(len) || len < 0) {
          failAt(lenNode, "TSB1023", "ArrayN length must be a non-negative integer literal.");
        }
        return { kind: "array", inner: typeNodeToRust(inner), len };
      }

      if (typeNameSegments.length === 1 && baseName === "global_ptr") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1020", "global_ptr<T> must have exactly one type argument.");
        return pathType(["__tsuba_cuda", "DevicePtr"], [typeNodeToRust(inner)]);
      }

      // Nominal/user-defined types (including crate types) are allowed as identifiers (and qualified names).
      // v0 supports generic type application for nominal types.
      const typeArgs = (typeNode.typeArguments ?? []).map((t) => typeNodeToRust(t));
      return pathType(typeNameSegments, typeArgs);
    }
  }
  if (ts.isTupleTypeNode(typeNode)) {
    const elems = typeNode.elements.map((el) =>
      ts.isNamedTupleMember(el) ? typeNodeToRust(el.type) : typeNodeToRust(el)
    );
    return { kind: "tuple", elems };
  }
  failAt(typeNode, "TSB1010", `Unsupported type annotation: ${typeNode.getText()}`);
}

function unwrapPromiseInnerType(
  ownerNode: ts.Node,
  ownerLabel: string,
  typeNode: ts.TypeNode | undefined,
  code: string
): ts.TypeNode {
  if (!typeNode) {
    failAt(ownerNode, code, `${ownerLabel}: async functions must declare an explicit Promise<...> return type in v0.`);
  }
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName) || typeNode.typeName.text !== "Promise") {
    failAt(ownerNode, code, `${ownerLabel}: async functions must return Promise<T> in v0.`);
  }
  const [inner] = typeNode.typeArguments ?? [];
  if (!inner) {
    failAt(typeNode, code, `${ownerLabel}: Promise<T> must have exactly one type argument in v0.`);
  }
  return inner;
}

function lowerTypeParameter(
  ownerNode: ts.Node,
  ownerLabel: string,
  p: ts.TypeParameterDeclaration,
  code: string
): RustGenericParam {
  if (!ts.isIdentifier(p.name)) {
    failAt(ownerNode, code, `${ownerLabel}: unsupported generic parameter declaration in v0.`);
  }

  const bounds: RustType[] = [];
  const constraint = p.constraint;
  if (constraint) {
    const pushBound = (node: ts.TypeNode): void => {
      const ty = typeNodeToRust(node);
      if (ty.kind !== "path") {
        failAt(node, code, `${ownerLabel}: generic constraint must be a nominal trait/type path in v0.`);
      }
      bounds.push(ty);
    };

    if (ts.isIntersectionTypeNode(constraint)) {
      if (constraint.types.length === 0) {
        failAt(constraint, code, `${ownerLabel}: empty intersection constraints are not supported in v0.`);
      }
      for (const part of constraint.types) pushBound(part);
    } else {
      pushBound(constraint);
    }
  }

  return { name: p.name.text, bounds };
}

function lowerTypeParameters(
  ownerNode: ts.Node,
  ownerLabel: string,
  params: readonly ts.TypeParameterDeclaration[] | undefined,
  code: string
): readonly RustGenericParam[] {
  if (!params || params.length === 0) return [];
  return params.map((p) => lowerTypeParameter(ownerNode, ownerLabel, p, code));
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

function isMutMarkerType(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  if (!ts.isTypeReferenceNode(typeNode)) return false;
  const tn = typeNode.typeName;
  if (!ts.isIdentifier(tn)) return false;
  return tn.text === "mut";
}

function isMacroType(checker: ts.TypeChecker, node: ts.Expression): boolean {
  const ty = checker.getTypeAtLocation(node);
  return ty.getProperty("__tsuba_macro") !== undefined;
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

function lowerArrowToClosure(
  ctx: EmitCtx,
  fn: ts.ArrowFunction,
  moveCapture: boolean
): RustExpr {
  if ((fn.typeParameters?.length ?? 0) > 0) {
    failAt(fn, "TSB1100", "Generic arrow functions are not supported in v0.");
  }

  const params = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name)) {
      failAt(p.name, "TSB1100", "Arrow function parameters must be identifiers in v0.");
    }
    if (p.name.text === "this") {
      failAt(p.name, "TSB1100", "Arrow functions cannot declare a `this` parameter in v0.");
    }
    if (!p.type) {
      failAt(p, "TSB1100", `Arrow function parameter '${p.name.text}' must have a type annotation in v0.`);
    }
    if (p.questionToken || p.initializer) {
      failAt(p, "TSB1100", "Arrow functions do not support optional/default parameters in v0.");
    }
    return { name: p.name.text, type: typeNodeToRust(p.type) };
  });

  if (ts.isBlock(fn.body)) {
    failAt(fn.body, "TSB1100", "Arrow functions with block bodies are not supported in v0.");
  }

  return {
    kind: "closure",
    move: moveCapture,
    params,
    body: lowerExpr(ctx, fn.body),
  };
}

function lowerExpr(ctx: EmitCtx, expr: ts.Expression): RustExpr {
  if (ts.isParenthesizedExpression(expr)) return { kind: "paren", expr: lowerExpr(ctx, expr.expression) };

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
      const list = ctx.shapeStructsByFile.get(span.fileName) ?? [];
      list.push(def);
      ctx.shapeStructsByFile.set(span.fileName, list);
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
      for (let i = 0; i < callArgs.length; i++) {
        const arg = callArgs[i]!;
        const param = effectiveParams[i];
        if (!param || !param.type) {
          next.push(arg);
          continue;
        }
        const rustTy = typeNodeToRust(param.type);
        if (rustTy.kind !== "ref") {
          next.push(arg);
          continue;
        }
        if (rustTy.mut) {
          const okPlace =
            arg.kind === "ident" || arg.kind === "field" || arg.kind === "index";
          if (!okPlace) {
            failAt(expr.arguments[i]!, "TSB1310", "&mut arguments must be place expressions in v0.");
          }
        }
        next.push({ kind: "borrow", mut: rustTy.mut, expr: arg });
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
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) {
      failAt(st.expression, "TSB2200", "switch(...) is only supported as switch(x.<disc>) in v0.");
    }
    const targetIdent = e.expression;
    const discName = e.name.text;

    const targetType = ctx.checker.getTypeAtLocation(targetIdent);
    const key = unionKeyFromType(targetType);
    const def = key ? ctx.unions.get(key) : undefined;
    if (!def) {
      failAt(targetIdent, "TSB2201", "switch(...) is only supported for discriminated unions in v0.");
    }
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

      if (clause.statements.length === 0) {
        failAt(clause, "TSB2207", "Empty switch cases are not supported in v0 (no fallthrough).");
      }

      const last = clause.statements.at(-1);
      if (!last) failAt(clause, "TSB2207", "Empty switch cases are not supported in v0 (no fallthrough).");
      const bodyStmtsNodes =
        ts.isBreakStatement(last) ? clause.statements.slice(0, -1) : clause.statements;
      if (!ts.isBreakStatement(last) && !ts.isReturnStatement(last)) {
        failAt(
          last,
          "TSB2208",
          "Switch cases must end with `break;` or `return ...;` in v0 (no fallthrough)."
        );
      }
      for (const s0 of bodyStmtsNodes) {
        if (ts.isBreakStatement(s0)) {
          failAt(s0, "TSB2209", "break; is only allowed as the final statement in a switch case in v0.");
        }
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
        thisName: ctx.thisName,
        fieldBindings: inherited,
      };

      const body: RustStmt[] = [];
      for (const s0 of bodyStmtsNodes) body.push(...lowerStmt(armCtx, s0));

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
  if (!fnDecl.name) fail("TSB3000", "Unnamed functions are not supported in v0.");
  if (!fnDecl.body) failAt(fnDecl, "TSB3001", `Function '${fnDecl.name.text}' must have a body in v0.`);

  const span = spanFromNode(fnDecl);
  const hasExport = fnDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const isAsync = hasModifier(fnDecl, ts.SyntaxKind.AsyncKeyword);
  const vis = hasExport ? "pub" : "private";
  const typeParams = lowerTypeParameters(fnDecl, `Function '${fnDecl.name.text}'`, fnDecl.typeParameters, "TSB3005");

  const params: RustParam[] = [];
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
    if (p.questionToken || p.initializer) {
      failAt(p, "TSB3004", `Function '${fnDecl.name.text}': optional/default params are not supported in v0.`);
    }
    params.push({ name: p.name.text, type: typeNodeToRust(p.type) });
  }

  const ret = isAsync
    ? typeNodeToRust(unwrapPromiseInnerType(fnDecl, `Function '${fnDecl.name.text}'`, fnDecl.type, "TSB3010"))
    : typeNodeToRust(fnDecl.type);
  const body: RustStmt[] = [];
  const fnCtx: EmitCtx = { ...ctx, inAsync: isAsync };
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

function methodReceiverFromThisParam(typeNode: ts.TypeNode | undefined): { readonly mut: boolean; readonly lifetime?: string } | undefined {
  if (!typeNode) return undefined;
  if (!ts.isTypeReferenceNode(typeNode)) return undefined;
  if (!ts.isIdentifier(typeNode.typeName)) return undefined;
  const name = typeNode.typeName.text;
  if (name === "ref" || name === "mutref") return { mut: name === "mutref" };
  if (name === "refLt" || name === "mutrefLt") {
    const [lt] = typeNode.typeArguments ?? [];
    if (!lt || !ts.isLiteralTypeNode(lt) || !ts.isStringLiteral(lt.literal)) return undefined;
    return { mut: name === "mutrefLt", lifetime: lt.literal.text };
  }
  return undefined;
}

function lowerClass(ctx: EmitCtx, cls: ts.ClassDeclaration, attrs: readonly string[]): readonly RustItem[] {
  if (!cls.name) failAt(cls, "TSB4000", "Anonymous classes are not supported in v0.");

  const className = cls.name.text;
  const classSpan = spanFromNode(cls);
  const classTypeParams = lowerTypeParameters(cls, `Class '${className}'`, cls.typeParameters, "TSB4001");
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
      if (p.questionToken || p.initializer) {
        failAt(p, "TSB4024", "Optional/default ctor params are not supported in v0.");
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
    const methodTypeParams = lowerTypeParameters(m, `Method '${m.name.text}'`, m.typeParameters, "TSB4103");

    const isPrivate =
      m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword) ??
      false;
    const vis = isPrivate ? "private" : "pub";

    let receiver: { readonly kind: "ref_self"; readonly mut: boolean; readonly lifetime?: string } = {
      kind: "ref_self",
      mut: false,
    };
    const params: RustParam[] = [];
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
      if (p.questionToken || p.initializer) {
        failAt(p, "TSB4107", "Optional/default params are not supported in v0.");
      }
      params.push({ name: p.name.text, type: typeNodeToRust(p.type) });
    }

    const ret = isAsync
      ? typeNodeToRust(unwrapPromiseInnerType(m, `Method '${m.name.text}'`, m.type, "TSB4108"))
      : typeNodeToRust(m.type);
    const body: RustStmt[] = [];
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
      thisName: "self",
      inAsync: isAsync,
    };
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
    const traitSegs = imp.traitPath.kind === "path" ? imp.traitPath.path.segments : [];
    const traitName = traitSegs.length > 0 ? traitSegs[traitSegs.length - 1]! : undefined;
    const traitCandidates = traitName
      ? [...(ctx.traitsByName.get(traitName) ?? [])].sort((a, b) => a.key.localeCompare(b.key))
      : [];
    const traitArity = imp.traitPath.kind === "path" ? imp.traitPath.args.length : 0;
    const traitDef = traitCandidates.find((t) => t.typeParams.length === traitArity);

    const traitItems: RustItem[] = [];
    if (traitDef) {
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
        if (got.typeParams.length !== req.typeParams.length) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' generic arity mismatch for '${traitDef.name}'.`
          );
        }
        for (let i = 0; i < got.typeParams.length; i++) {
          const g = got.typeParams[i]!;
          const r = req.typeParams[i]!;
          if (g.name !== r.name || g.bounds.length !== r.bounds.length) {
            failAt(imp.node, "TSB4007", `Trait method '${req.name}' generic constraint mismatch for '${traitDef.name}'.`);
          }
          for (let j = 0; j < g.bounds.length; j++) {
            if (!rustTypeEq(g.bounds[j]!, r.bounds[j]!)) {
              failAt(imp.node, "TSB4007", `Trait method '${req.name}' generic constraint mismatch for '${traitDef.name}'.`);
            }
          }
        }
        if (got.params.length !== req.params.length) {
          failAt(
            imp.node,
            "TSB4007",
            `Trait method '${req.name}' parameter arity mismatch for '${traitDef.name}'.`
          );
        }
        for (let i = 0; i < got.params.length; i++) {
          const gp = got.params[i]!;
          const rp = req.params[i]!;
          if (gp.name !== rp.name || !rustTypeEq(gp.type, rp.type)) {
            failAt(imp.node, "TSB4007", `Trait method '${req.name}' parameter mismatch for '${traitDef.name}'.`);
          }
        }
        if (!rustTypeEq(got.ret, req.ret)) {
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
    }

    traitImpls.push({
      kind: "impl",
      span: classSpan,
      typeParams: classTypeParams,
      traitPath: imp.traitPath,
      typePath: classTypePath,
      items: traitItems,
    });
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

  return [];
}

function parseInterfaceMethod(
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
  const typeParams = lowerTypeParameters(member, owner, member.typeParameters, "TSB5105");

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
    if (p.questionToken || p.initializer) {
      failAt(p, "TSB5109", `${owner}: optional/default parameters are not supported in v0.`);
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

function parseTraitDef(decl: ts.InterfaceDeclaration): TraitDef {
  const key = traitKeyFromDecl(decl);
  const vis: "pub" | "private" = hasModifier(decl, ts.SyntaxKind.ExportKeyword) ? "pub" : "private";
  const typeParams = lowerTypeParameters(decl, `Interface '${decl.name.text}'`, decl.typeParameters, "TSB5100");

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

  const methods = decl.members.map((m) => parseInterfaceMethod(decl, m));
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
  const def = ctx.traitsByKey.get(traitKeyFromDecl(decl)) ?? parseTraitDef(decl);
  return [lowerTraitDef(def)];
}

export function compileHostToRust(opts: CompileHostOptions): CompileHostOutput {
  // Phase 1: bootstrap TypeScript program + entry contract checks.
  const bootstrap = bootstrapCompileHost(opts);
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
  const { userFilesByName, moduleNameByFile } = createUserModuleIndex(userSourceFiles, entryFileName);

  type FileLowered = {
    readonly fileName: string;
    readonly sourceFile: ts.SourceFile;
    readonly uses: RustItem[];
    readonly classes: { readonly pos: number; readonly decl: ts.ClassDeclaration }[];
    readonly functions: { readonly pos: number; readonly decl: ts.FunctionDeclaration }[];
    readonly typeAliases: { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[];
    readonly interfaces: { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[];
    readonly annotations: readonly {
      readonly pos: number;
      readonly node: ts.Statement;
      readonly target: string;
      readonly attrs: readonly string[];
    }[];
  };

  // Phase 4: lower file top-level declarations/imports to typed IR buckets.
  const loweredByFile = new Map<string, FileLowered>();

  for (const f of userSourceFiles) {
    const fileName = normalizePath(f.fileName);
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
          failAt(specNode, "TSB3205", "Import module specifier must be a string literal in v0.");
        }
        const spec = specNode.text;

        // Marker/facade imports: compile-time only, no Rust `use` emitted.
        if (isMarkerModuleSpecifier(spec)) continue;

        const clause = st.importClause;
        if (!clause) {
          failAt(st, "TSB3206", "Side-effect-only imports are not supported in v0.");
        }
        if (clause.name) {
          failAt(clause.name, "TSB3207", "Default imports are not supported in v0.");
        }

        const bindings = clause.namedBindings;
        if (!bindings) {
          failAt(st, "TSB3208", "Import must have named bindings in v0.");
        }

        if (ts.isNamespaceImport(bindings)) {
          failAt(bindings, "TSB3209", "Namespace imports (import * as x) are not supported in v0.");
        }
        if (!ts.isNamedImports(bindings)) {
          failAt(bindings, "TSB3210", "Unsupported import binding form in v0.");
        }

        if (spec.startsWith(".")) {
          const resolved = resolveRelativeImport(f.fileName, spec, userFilesByName, moduleNameByFile);
          for (const el of bindings.elements) {
            if (kernelDeclForIdentifier(ctx, el.name)) continue;
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
              span: spanFromNode(el),
              path: { segments: ["crate", resolved.mod, exported] },
              alias: local !== exported ? local : undefined,
            });
          }
        } else {
          const pkgName = packageNameFromSpecifier(spec);
          const pkgRoot = findNodeModulesPackageRoot(f.fileName, pkgName);
          if (!pkgRoot) {
            failAt(specNode, "TSB3211", `Could not resolve package '${pkgName}' for import ${JSON.stringify(spec)}.`);
          }
          const manifestPath = join(pkgRoot, "tsuba.bindings.json");
          if (!existsSync(manifestPath)) {
            failAt(
              specNode,
              "TSB3212",
              `No tsuba.bindings.json found for package '${pkgName}' (needed for import ${JSON.stringify(spec)}).`
            );
          }
          const manifest = readBindingsManifest(manifestPath, specNode);
          const rustModule = manifest.modules[spec];
          if (!rustModule) {
            failAt(
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
            addUsedCrate(usedCratesByName, specNode, { ...depBase, path: manifest.crate.path });
          } else {
            addUsedCrate(usedCratesByName, specNode, { ...depBase, version: manifest.crate.version! });
          }

          const baseSegs = splitRustPath(rustModule);
          for (const el of bindings.elements) {
            if (kernelDeclForIdentifier(ctx, el.name)) continue;
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
              span: spanFromNode(el),
              path: { segments: [...baseSegs, exported] },
              alias: local !== exported ? local : undefined,
            });
          }
        }
        continue;
      }

      if (
        ts.isExportDeclaration(st) ||
        ts.isEmptyStatement(st)
      ) {
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

      const ann = tryParseAnnotateStatement(ctx, st);
      if (ann) {
        annotations.push({ pos: st.pos, node: st, target: ann.target, attrs: [...ann.attrs] });
        continue;
      }

      if (ts.isVariableStatement(st)) {
        if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;

        // Allow kernel declarations (compile-time only):
        //   const k = kernel({ ... } as const, (...) => ...)
        const declList = st.declarationList;
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) failAt(st, "TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);

        const allKernelDecls = declList.declarations.every((d) => {
          if (!ts.isIdentifier(d.name)) return false;
          if (!d.initializer) return false;
          if (!ts.isCallExpression(d.initializer)) return false;
          if (!ts.isIdentifier(d.initializer.expression)) return false;
          return (
            d.initializer.expression.text === "kernel" &&
            isFromTsubaGpuLang(ctx, d.initializer.expression)
          );
        });

        if (allKernelDecls) continue;

        failAt(st, "TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);
      }

      if (ts.isFunctionDeclaration(st)) {
        if (!st.body) continue; // ambient
        if (!st.name) failAt(st, "TSB3000", "Unnamed functions are not supported in v0.");
        if (st.name.text === "main" && fileName === entryFileName) continue;

        functions.push({ pos: st.pos, decl: st });
        continue;
      }

      if (ts.isClassDeclaration(st)) {
        if (!st.name) failAt(st, "TSB4000", "Anonymous classes are not supported in v0.");
        classes.push({ pos: st.pos, decl: st });
        continue;
      }

      failAt(st, "TSB3102", `Unsupported top-level statement: ${st.getText()}`);
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

  // Phase 5: pre-collect cross-file type models (unions/struct aliases/traits).
  for (const lowered of loweredByFile.values()) {
    for (const ta of lowered.typeAliases) {
      const unionDef = tryParseDiscriminatedUnionTypeAlias(ta.decl);
      if (unionDef) ctx.unions.set(unionDef.key, unionDef);

      const structDef = tryParseStructTypeAlias(ta.decl);
      if (structDef) ctx.structs.set(structDef.key, structDef);
    }
    for (const i0 of lowered.interfaces) {
      const traitDef = parseTraitDef(i0.decl);
      ctx.traitsByKey.set(traitDef.key, traitDef);
      const existing = ctx.traitsByName.get(traitDef.name) ?? [];
      existing.push(traitDef);
      ctx.traitsByName.set(traitDef.name, existing);
    }
  }

  // Phase 6: collect `annotate(...)` markers and validate declaration ordering.
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
      const key = unionKeyFromDecl(t0.decl);
      if (ctx.unions.has(key) || ctx.structs.has(key)) {
        declPosByName.set(t0.decl.name.text, t0.pos);
      }
    }
    if (fileName === entryFileName) {
      declPosByName.set("main", mainFn.pos);
    }

    const attrsByName = new Map<string, string[]>();
    for (const a of lowered.annotations) {
      const declPos = declPosByName.get(a.target);
      if (declPos === undefined) {
        failAt(a.node, "TSB3310", `annotate(...) target '${a.target}' was not found in this module.`);
      }
      if (a.pos <= declPos) {
        failAt(a.node, "TSB3311", `annotate(${a.target}, ...) must appear after the declaration in v0.`);
      }
      const list = attrsByName.get(a.target) ?? [];
      list.push(...a.attrs);
      attrsByName.set(a.target, list);
    }
    attrsByFile.set(fileName, attrsByName);
  }

  // Phase 7: emit module + root items into Rust IR in deterministic order.
  // Root (entry file) uses
  const rootLowered = loweredByFile.get(entryFileName);
  if (!rootLowered) fail("TSB0001", "Internal error: entry file missing from lowered set.");
  items.push(...sortUseItems(rootLowered.uses));

  // Modules (non-entry files)
  const moduleFiles = [...moduleNameByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [fileName, modName] of moduleFiles) {
    const lowered = loweredByFile.get(fileName);
    if (!lowered) continue;
    const fileAttrs = attrsByFile.get(fileName) ?? new Map<string, readonly string[]>();
    const itemGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];
    for (const t0 of lowered.typeAliases) {
      itemGroups.push({
        pos: t0.pos,
        items: lowerTypeAlias(ctx, t0.decl, fileAttrs.get(t0.decl.name.text) ?? []),
      });
    }
    for (const i0 of lowered.interfaces) itemGroups.push({ pos: i0.pos, items: lowerInterface(ctx, i0.decl) });
    for (const c of lowered.classes) {
      itemGroups.push({
        pos: c.pos,
        items: lowerClass(ctx, c.decl, fileAttrs.get(c.decl.name?.text ?? "") ?? []),
      });
    }
    for (const f0 of lowered.functions) {
      itemGroups.push({
        pos: f0.pos,
        items: [lowerFunction(ctx, f0.decl, fileAttrs.get(f0.decl.name?.text ?? "") ?? [])],
      });
    }
    itemGroups.sort((a, b) => a.pos - b.pos);
    const declItems = itemGroups.flatMap((g) => g.items);

    const usesSorted = sortUseItems(lowered.uses);
    const shapeStructs = [...(ctx.shapeStructsByFile.get(fileName) ?? [])].sort(
      (a, b) => a.span.start - b.span.start || a.key.localeCompare(b.key)
    );
    const shapeItems = shapeStructs.map((d) => structItemFromDef(d, []));

    const modItems: RustItem[] = [...usesSorted, ...shapeItems, ...declItems];
    items.push({ kind: "mod", name: modName, items: modItems });
  }

  // Root declarations (entry file only, excluding main)
  const rootGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];
  const rootAttrs = attrsByFile.get(entryFileName) ?? new Map<string, readonly string[]>();
  for (const t0 of rootLowered.typeAliases) {
    rootGroups.push({
      pos: t0.pos,
      items: lowerTypeAlias(ctx, t0.decl, rootAttrs.get(t0.decl.name.text) ?? []),
    });
  }
  for (const i0 of rootLowered.interfaces) rootGroups.push({ pos: i0.pos, items: lowerInterface(ctx, i0.decl) });
  for (const c of rootLowered.classes) {
    rootGroups.push({
      pos: c.pos,
      items: lowerClass(ctx, c.decl, rootAttrs.get(c.decl.name?.text ?? "") ?? []),
    });
  }
  for (const f0 of rootLowered.functions) {
    rootGroups.push({
      pos: f0.pos,
      items: [lowerFunction(ctx, f0.decl, rootAttrs.get(f0.decl.name?.text ?? "") ?? [])],
    });
  }
  rootGroups.sort((a, b) => a.pos - b.pos);
  items.push(...rootGroups.flatMap((g) => g.items));

  // Phase 8: lower entry main body and finalize Rust program text.
  const mainBody: RustStmt[] = [];
  const mainCtx: EmitCtx = { ...ctx, inAsync: mainIsAsync };
  for (const st of mainFn.body!.statements) mainBody.push(...lowerStmt(mainCtx, st));

  const rootShapeStructs = [...(ctx.shapeStructsByFile.get(entryFileName) ?? [])].sort(
    (a, b) => a.span.start - b.span.start || a.key.localeCompare(b.key)
  );
  for (const d of rootShapeStructs) items.push(structItemFromDef(d, []));

  const mainItem: RustItem = {
    kind: "fn",
    span: spanFromNode(mainFn),
    vis: "private",
    async: mainIsAsync,
    typeParams: [],
    receiver: { kind: "none" },
    name: "main",
    params: [],
    ret: returnKind === "unit" ? unitType() : (rustReturnType ?? unitType()),
    attrs: [
      ...(mainIsAsync && runtimeKind === "tokio" ? ["#[tokio::main]"] : []),
      ...(rootAttrs.get("main") ?? []),
    ],
    body: mainBody,
  };
  items.push(mainItem);

  const rustProgram: RustProgram = { kind: "program", items };
  let mainRs = writeRustProgram(rustProgram, { header: ["// Generated by @tsuba/compiler (v0)"] });
  if (ctx.gpuRuntime.used) {
    mainRs = `${mainRs}\n${renderCudaRuntimeModule(kernels)}\n`;
  }

  const crates = [...usedCratesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { mainRs, kernels, crates };
}
