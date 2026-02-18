import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { RustExpr, RustItem, RustMatchArm, RustParam, RustProgram, RustStmt, RustType, Span } from "./ir.js";
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
    super(message);
    this.code = code;
    this.span = span;
    this.name = "CompileError";
  }
}

export type CompileHostOptions = {
  readonly entryFile: string;
};

export type CrateDep = {
  readonly name: string;
  readonly version: string;
  readonly features?: readonly string[];
};

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

type EmitCtx = {
  readonly checker: ts.TypeChecker;
  readonly thisName?: string;
  readonly unions: ReadonlyMap<string, UnionDef>;
  readonly fieldBindings?: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

type BindingsManifest = {
  readonly schema: number;
  readonly kind: "crate";
  readonly crate: {
    readonly name: string;
    readonly version: string;
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

function unionKeyFromType(type: ts.Type): string | undefined {
  const alias = (type as unknown as { readonly aliasSymbol?: ts.Symbol }).aliasSymbol;
  if (!alias) return undefined;
  for (const d of alias.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(d)) return unionKeyFromDecl(d);
  }
  return undefined;
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
  const m = parsed as Partial<BindingsManifest>;
  if (m.schema !== 1) {
    failAt(specNode, "TSB3222", `${path}: unsupported schema (expected 1).`);
  }
  if (m.kind !== "crate") {
    failAt(specNode, "TSB3223", `${path}: unsupported kind (expected "crate").`);
  }
  if (!m.crate || typeof m.crate.name !== "string" || typeof m.crate.version !== "string") {
    failAt(specNode, "TSB3224", `${path}: missing crate.name/crate.version.`);
  }
  if (m.crate.features !== undefined) {
    if (!Array.isArray(m.crate.features) || !m.crate.features.every((x) => typeof x === "string")) {
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

export type KernelDecl = {
  readonly name: string;
  readonly specText: string;
};

function isAsConstObjectLiteral(expr: ts.Expression): expr is ts.AsExpression {
  if (!ts.isAsExpression(expr)) return false;
  if (!ts.isTypeReferenceNode(expr.type)) return false;
  if (!ts.isIdentifier(expr.type.typeName)) return false;
  if (expr.type.typeName.text !== "const") return false;
  return ts.isObjectLiteralExpression(expr.expression);
}

function collectKernelDecls(ctx: EmitCtx, sf: ts.SourceFile): readonly KernelDecl[] {
  const out: KernelDecl[] = [];
  const seen = new Set<string>();

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
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) failAt(declList, "TSB1401", "kernel(...) must be assigned to a const in v0.");

        const name = node.parent.name.text;
        if (seen.has(name)) failAt(node.parent.name, "TSB1402", `Duplicate kernel name '${name}'.`);
        seen.add(name);

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

        out.push({ name, specText: specArg.expression.getText(sf) });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return out;
}

const rustPrimitiveTypes = new Map<string, RustType>([
  ["i8", pathType(["i8"])],
  ["i16", pathType(["i16"])],
  ["i32", pathType(["i32"])],
  ["i64", pathType(["i64"])],
  ["isize", pathType(["isize"])],
  ["u8", pathType(["u8"])],
  ["u16", pathType(["u16"])],
  ["u32", pathType(["u32"])],
  ["u64", pathType(["u64"])],
  ["usize", pathType(["usize"])],
  ["f32", pathType(["f32"])],
  ["f64", pathType(["f64"])],
  ["bool", pathType(["bool"])],
  ["String", pathType(["std", "string", "String"])],
]);

function fail(code: string, message: string): never {
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

function typeNodeToRust(typeNode: ts.TypeNode | undefined): RustType {
  if (!typeNode) return unitType();
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return unitType();
  if (ts.isTypeReferenceNode(typeNode)) {
    const tn = typeNode.typeName;
    if (ts.isIdentifier(tn)) {
      const mapped = rustPrimitiveTypes.get(tn.text);
      if (mapped) return mapped;

      if (tn.text === "ref" || tn.text === "mutref") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1016", `${tn.text}<T> must have exactly one type argument.`);
        return { kind: "ref", mut: tn.text === "mutref", inner: typeNodeToRust(inner) };
      }

      if (tn.text === "refLt" || tn.text === "mutrefLt") {
        const [lt, inner] = typeNode.typeArguments ?? [];
        if (!lt || !inner) failAt(typeNode, "TSB1017", `${tn.text}<L,T> must have exactly two type arguments.`);
        if (!ts.isLiteralTypeNode(lt) || !ts.isStringLiteral(lt.literal)) {
          failAt(lt, "TSB1018", `${tn.text} lifetime must be a string literal (e.g., refLt<\"a\", T>).`);
        }
        return {
          kind: "ref",
          mut: tn.text === "mutrefLt",
          lifetime: lt.literal.text,
          inner: typeNodeToRust(inner),
        };
      }

      // mut<T> marker -> let mut + T
      if (tn.text === "mut") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1011", "mut<T> must have exactly one type argument.");
        return typeNodeToRust(inner);
      }

      if (tn.text === "Option") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1012", "Option<T> must have exactly one type argument.");
        return pathType(["Option"], [typeNodeToRust(inner)]);
      }

      if (tn.text === "Result") {
        const [okTy, errTy] = typeNode.typeArguments ?? [];
        if (!okTy || !errTy) failAt(typeNode, "TSB1013", "Result<T,E> must have exactly two type arguments.");
        return pathType(["Result"], [typeNodeToRust(okTy), typeNodeToRust(errTy)]);
      }

      if (tn.text === "Vec") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) failAt(typeNode, "TSB1014", "Vec<T> must have exactly one type argument.");
        return pathType(["Vec"], [typeNodeToRust(inner)]);
      }

      if (tn.text === "HashMap") {
        const [k, v] = typeNode.typeArguments ?? [];
        if (!k || !v) failAt(typeNode, "TSB1015", "HashMap<K,V> must have exactly two type arguments.");
        return pathType(["std", "collections", "HashMap"], [typeNodeToRust(k), typeNodeToRust(v)]);
      }

      // Nominal/user-defined types (including Rust types) are allowed as bare identifiers.
      // v0 does not support generic type application for nominal types yet.
      if ((typeNode.typeArguments?.length ?? 0) > 0) {
        failAt(typeNode, "TSB1019", `Generic nominal types are not supported in v0: ${typeNode.getText()}`);
      }
      return pathType([tn.text]);
    }
  }
  failAt(typeNode, "TSB1010", `Unsupported type annotation: ${typeNode.getText()}`);
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

function lowerExpr(ctx: EmitCtx, expr: ts.Expression): RustExpr {
  if (ts.isParenthesizedExpression(expr)) return { kind: "paren", expr: lowerExpr(ctx, expr.expression) };

  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    if (!ctx.thisName) {
      failAt(expr, "TSB1112", "`this` is only supported inside methods/constructors in v0.");
    }
    return identExpr(ctx.thisName);
  }

  if (ts.isIdentifier(expr)) {
    if (expr.text === "undefined") {
      failAt(expr, "TSB1101", "The value 'undefined' is not supported in v0; use Option/None or () explicitly.");
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
    return { kind: "index", expr: lowerExpr(ctx, expr.expression), index: lowerExpr(ctx, index) };
  }

  if (ts.isArrayLiteralExpression(expr)) {
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
    const ctxt = ctx.checker.getContextualType(expr);
    if (!ctxt) {
      failAt(expr, "TSB1115", "Object literals require a contextual type in v0.");
    }
    const key = unionKeyFromType(ctxt);
    const def = key ? ctx.unions.get(key) : undefined;
    if (!def) {
      failAt(
        expr,
        "TSB1117",
        "Only object literals constructing discriminated unions are supported in v0."
      );
    }

    const props = new Map<string, ts.Expression>();
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) {
        failAt(p, "TSB1118", "Object spread is not supported in v0.");
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        props.set(p.name.text, p.name);
        continue;
      }
      if (!ts.isPropertyAssignment(p)) {
        failAt(p, "TSB1119", "Unsupported object literal property form in v0.");
      }
      if (!ts.isIdentifier(p.name)) {
        failAt(p.name, "TSB1120", "Only identifier-named object literal properties are supported in v0.");
      }
      props.set(p.name.text, p.initializer);
    }

    const discExpr = props.get(def.discriminant);
    if (!discExpr || !ts.isStringLiteral(discExpr)) {
      failAt(
        expr,
        "TSB1121",
        `Union '${def.name}' object literal must include ${def.discriminant}: \"...\".`
      );
    }
    const tag = discExpr.text;
    const variant = def.variants.find((v) => v.tag === tag);
    if (!variant) {
      failAt(
        discExpr,
        "TSB1122",
        `Unknown union tag '${tag}' for ${def.name}.`
      );
    }

    const allowed = new Set<string>([def.discriminant, ...variant.fields.map((f) => f.name)]);
    for (const k0 of props.keys()) {
      if (!allowed.has(k0)) {
        failAt(expr, "TSB1123", `Unknown property '${k0}' for union variant '${tag}' in ${def.name}.`);
      }
    }

    const fields = variant.fields.map((f) => {
      const v = props.get(f.name);
      if (!v) {
        failAt(expr, "TSB1124", `Missing required field '${f.name}' for union variant '${tag}' in ${def.name}.`);
      }
      return { name: f.name, expr: lowerExpr(ctx, v) };
    });

    if (fields.length === 0) {
      return pathExpr([def.name, variant.name]);
    }
    return { kind: "struct_lit", typePath: { segments: [def.name, variant.name] }, fields };
  }

  if (ts.isNewExpression(expr)) {
    if (!ts.isIdentifier(expr.expression)) {
      failAt(expr.expression, "TSB1113", "new expressions must use an identifier constructor in v0.");
    }
    if ((expr.typeArguments?.length ?? 0) > 0) {
      failAt(expr, "TSB1114", "Generic `new` expressions are not supported in v0.");
    }
    const args = (expr.arguments ?? []).map((a) => lowerExpr(ctx, a));
    return {
      kind: "assoc_call",
      typePath: { segments: [expr.expression.text] },
      typeArgs: [],
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
    }

    // GPU kernel markers (compile-time only)
    if (ts.isIdentifier(expr.expression) && isFromTsubaGpuLang(ctx, expr.expression)) {
      if (expr.expression.text === "kernel") {
        return identExpr("__tsuba_kernel_placeholder");
      }
    }

    // Core markers (compile-time only)
    if (ts.isIdentifier(expr.expression) && isFromTsubaCoreLang(ctx, expr.expression)) {
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
      if (!ts.isIdentifier(expr.expression)) {
        failAt(expr.expression, "TSB1301", "Macro calls must use an identifier callee in v0.");
      }
      return { kind: "macro_call", name: expr.expression.text, args };
    }

    return { kind: "call", callee: lowerExpr(ctx, expr.expression), args };
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
        pattern: { kind: "ident", name: decl.name.text },
        mut: true,
        type: typeNodeToRust(inner),
        init: lowerExpr(ctx, decl.initializer),
      });
      continue;
    }

    out.push({
      kind: "let",
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
        target: identExpr(name),
        expr: { kind: "binary", op, left: identExpr(name), right: { kind: "number", text: "1" } },
      },
    ];
  }

  return [{ kind: "expr", expr: lowerExpr(ctx, expr) }];
}

function lowerStmt(ctx: EmitCtx, st: ts.Statement): RustStmt[] {
  if (ts.isVariableStatement(st)) {
    return lowerVarDeclList(ctx, st.declarationList);
  }

  if (ts.isExpressionStatement(st)) {
    return lowerExprStmt(ctx, st.expression);
  }

  if (ts.isReturnStatement(st)) {
    return [{ kind: "return", expr: st.expression ? lowerExpr(ctx, st.expression) : undefined }];
  }

  if (ts.isIfStatement(st)) {
    const cond = lowerExpr(ctx, st.expression);
    const then = lowerStmtBlock(ctx, st.thenStatement);
    const elseStmts = st.elseStatement ? lowerStmtBlock(ctx, st.elseStatement) : undefined;
    return [{ kind: "if", cond, then, else: elseStmts }];
  }

  if (ts.isWhileStatement(st)) {
    const cond = lowerExpr(ctx, st.expression);
    const body = lowerStmtBlock(ctx, st.statement);
    return [{ kind: "while", cond, body }];
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
      const armCtx: EmitCtx = { checker: ctx.checker, unions: ctx.unions, thisName: ctx.thisName, fieldBindings: inherited };

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

    return [{ kind: "match", expr: identExpr(targetIdent.text), arms }];
  }

  if (ts.isBreakStatement(st)) {
    return [{ kind: "break" }];
  }

  if (ts.isContinueStatement(st)) {
    return [{ kind: "continue" }];
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
    const lowered: RustStmt = { kind: "while", cond: lowerExpr(ctx, condExpr), body: whileBody };
    return [{ kind: "block", body: [...initStmts, lowered] }];
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

function lowerFunction(ctx: EmitCtx, fnDecl: ts.FunctionDeclaration): RustItem {
  if (!fnDecl.name) fail("TSB3000", "Unnamed functions are not supported in v0.");
  if (!fnDecl.body) failAt(fnDecl, "TSB3001", `Function '${fnDecl.name.text}' must have a body in v0.`);

  const hasExport = fnDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const vis = hasExport ? "pub" : "private";

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

  const ret = typeNodeToRust(fnDecl.type);
  const body: RustStmt[] = [];
  for (const st of fnDecl.body.statements) body.push(...lowerStmt(ctx, st));

  return { kind: "fn", vis, receiver: { kind: "none" }, name: fnDecl.name.text, params, ret, body };
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

function lowerClass(ctx: EmitCtx, cls: ts.ClassDeclaration): readonly RustItem[] {
  if (!cls.name) failAt(cls, "TSB4000", "Anonymous classes are not supported in v0.");
  if (cls.typeParameters && cls.typeParameters.length > 0) {
    failAt(cls, "TSB4001", "Generic classes are not supported in v0.");
  }
  const implementsTraits: string[] = [];
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
        if ((t0.typeArguments?.length ?? 0) > 0) {
          failAt(t0, "TSB4004", "Generic implements is not supported in v0.");
        }
        if (!ts.isIdentifier(t0.expression)) {
          failAt(t0.expression, "TSB4005", "implements only supports identifier traits in v0.");
        }
        implementsTraits.push(t0.expression.text);
      }
    }
  }

  const hasExport = cls.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const classVis = hasExport ? "pub" : "private";
  const className = cls.name.text;

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
    vis: classVis,
    name: className,
    attrs: [],
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
    vis: "pub",
    receiver: { kind: "none" },
    name: "new",
    params: ctorParams,
    ret: pathType([className]),
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

  for (const m of methods) {
    if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword) ?? false) {
      failAt(m, "TSB4100", "Static methods are not supported in v0.");
    }
    if (!ts.isIdentifier(m.name)) failAt(m.name, "TSB4101", "Only identifier-named methods are supported in v0.");
    if (!m.body) failAt(m, "TSB4102", "Method must have a body in v0.");
    if (m.typeParameters && m.typeParameters.length > 0) {
      failAt(m, "TSB4103", "Generic methods are not supported in v0.");
    }

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

    const ret = typeNodeToRust(m.type);
    const body: RustStmt[] = [];
    const methodCtx: EmitCtx = { checker: ctx.checker, unions: ctx.unions, thisName: "self" };
    for (const st of m.body!.statements) body.push(...lowerStmt(methodCtx, st));

    implItems.push({
      kind: "fn",
      vis,
      receiver,
      name: m.name.text,
      params,
      ret,
      body,
    });
  }

  const implItem: RustItem = { kind: "impl", typePath: { segments: [className] }, items: implItems };

  const traitImpls: RustItem[] = implementsTraits.map((t) => ({
    kind: "impl",
    traitPath: { segments: [t] },
    typePath: { segments: [className] },
    items: [],
  }));

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

function lowerTypeAlias(ctx: EmitCtx, decl: ts.TypeAliasDeclaration): readonly RustItem[] {
  const def = ctx.unions.get(unionKeyFromDecl(decl));
  if (!def) return [];
  const isExport = hasModifier(decl, ts.SyntaxKind.ExportKeyword);
  const vis: "pub" | "private" = isExport ? "pub" : "private";

  return [
    {
      kind: "enum",
      vis,
      name: def.name,
      attrs: [],
      variants: def.variants.map((v) => ({
        name: v.name,
        fields: v.fields,
      })),
    },
  ];
}

function lowerInterface(decl: ts.InterfaceDeclaration): readonly RustItem[] {
  if (decl.typeParameters && decl.typeParameters.length > 0) {
    failAt(decl, "TSB5100", "Generic interfaces are not supported in v0.");
  }
  if (decl.heritageClauses && decl.heritageClauses.length > 0) {
    failAt(decl, "TSB5101", "Interface extends is not supported in v0.");
  }
  if (decl.members.length > 0) {
    failAt(decl, "TSB5102", "Interface members are not supported in v0 (marker traits only).");
  }

  const isExport = hasModifier(decl, ts.SyntaxKind.ExportKeyword);
  const vis: "pub" | "private" = isExport ? "pub" : "private";

  return [{ kind: "trait", vis, name: decl.name.text, items: [] }];
}

export function compileHostToRust(opts: CompileHostOptions): CompileHostOutput {
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

  const sf = program.getSourceFile(opts.entryFile);
  if (!sf) fail("TSB0001", `Could not read entry file: ${opts.entryFile}`);

  const mainFn = getExportedMain(sf);
  const returnTypeNode = mainFn.type;
  const returnKind: "unit" | "result" = (() => {
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

  const rustReturnType = returnKind === "result" ? typeNodeToRust(returnTypeNode) : undefined;

  const unionsByKey = new Map<string, UnionDef>();
  const ctx: EmitCtx = { checker, unions: unionsByKey };
  const kernels = collectKernelDecls(ctx, sf);
  const usedCratesByName = new Map<string, CrateDep>();

  function addUsedCrate(node: ts.Node, dep: CrateDep): void {
    const normalize = (d: CrateDep): CrateDep => {
      const features = (d.features ?? []).filter((x): x is string => typeof x === "string");
      const unique = [...new Set(features)].sort((a, b) => a.localeCompare(b));
      return unique.length === 0 ? { name: d.name, version: d.version } : { name: d.name, version: d.version, features: unique };
    };

    const prev = usedCratesByName.get(dep.name);
    if (!prev) {
      usedCratesByName.set(dep.name, normalize(dep));
      return;
    }
    if (prev.version !== dep.version) {
      failAt(
        node,
        "TSB3226",
        `Conflicting crate versions for '${dep.name}': '${prev.version}' vs '${dep.version}'.`
      );
    }
    const mergedFeatures = new Set<string>([...(prev.features ?? []), ...(dep.features ?? [])]);
    const features = [...mergedFeatures].sort((a, b) => a.localeCompare(b));
    usedCratesByName.set(
      dep.name,
      features.length === 0 ? { name: dep.name, version: dep.version } : { name: dep.name, version: dep.version, features }
    );
  }

  const items: RustItem[] = [];
  if (kernels.length > 0) {
    items.push({
      kind: "struct",
      vis: "private",
      name: "__tsuba_kernel_placeholder",
      attrs: ["#[allow(dead_code)]"],
      fields: [],
    });
  }

  const userSourceFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !isInNodeModules(f.fileName));

  const entryFileName = normalizePath(sf.fileName);

  const userFilesByName = new Map<string, ts.SourceFile>();
  for (const f of userSourceFiles) userFilesByName.set(normalizePath(f.fileName), f);

  // Map user files (excluding entry) to Rust module names.
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

  function resolveRelativeImport(fromFileName: string, spec: string): { readonly targetFile: string; readonly mod: string } {
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

  function sortUses(uses: readonly RustItem[]): RustItem[] {
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

  type FileLowered = {
    readonly fileName: string;
    readonly sourceFile: ts.SourceFile;
    readonly uses: RustItem[];
    readonly classes: { readonly pos: number; readonly decl: ts.ClassDeclaration }[];
    readonly functions: { readonly pos: number; readonly decl: ts.FunctionDeclaration }[];
    readonly typeAliases: { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[];
    readonly interfaces: { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[];
  };

  const loweredByFile = new Map<string, FileLowered>();

  for (const f of userSourceFiles) {
    const fileName = normalizePath(f.fileName);
    const uses: RustItem[] = [];
    const classes: { readonly pos: number; readonly decl: ts.ClassDeclaration }[] = [];
    const functions: { readonly pos: number; readonly decl: ts.FunctionDeclaration }[] = [];
    const typeAliases: { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[] = [];
    const interfaces: { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[] = [];

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
          const resolved = resolveRelativeImport(f.fileName, spec);
          for (const el of bindings.elements) {
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
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
          addUsedCrate(specNode, {
            name: manifest.crate.name,
            version: manifest.crate.version,
            features: manifest.crate.features,
          });

          const baseSegs = splitRustPath(rustModule);
          for (const el of bindings.elements) {
            const exported = el.propertyName?.text ?? el.name.text;
            const local = el.name.text;
            uses.push({
              kind: "use",
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

    loweredByFile.set(fileName, { fileName, sourceFile: f, uses, classes, functions, typeAliases, interfaces });
  }

  // Collect discriminated unions (type aliases) up-front so they can be used during expression/statement lowering.
  for (const lowered of loweredByFile.values()) {
    for (const ta of lowered.typeAliases) {
      const def = tryParseDiscriminatedUnionTypeAlias(ta.decl);
      if (!def) continue;
      unionsByKey.set(def.key, def);
    }
  }

  // Root (entry file) uses
  const rootLowered = loweredByFile.get(entryFileName);
  if (!rootLowered) fail("TSB0001", "Internal error: entry file missing from lowered set.");
  items.push(...sortUses(rootLowered.uses));

  // Modules (non-entry files)
  const moduleFiles = [...moduleNameByFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [fileName, modName] of moduleFiles) {
    const lowered = loweredByFile.get(fileName);
    if (!lowered) continue;
    const itemGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];
    for (const t0 of lowered.typeAliases) itemGroups.push({ pos: t0.pos, items: lowerTypeAlias(ctx, t0.decl) });
    for (const i0 of lowered.interfaces) itemGroups.push({ pos: i0.pos, items: lowerInterface(i0.decl) });
    for (const c of lowered.classes) itemGroups.push({ pos: c.pos, items: lowerClass(ctx, c.decl) });
    for (const f0 of lowered.functions) itemGroups.push({ pos: f0.pos, items: [lowerFunction(ctx, f0.decl)] });
    itemGroups.sort((a, b) => a.pos - b.pos);
    const declItems = itemGroups.flatMap((g) => g.items);

    const modItems: RustItem[] = [...sortUses(lowered.uses), ...declItems];
    items.push({ kind: "mod", name: modName, items: modItems });
  }

  // Root declarations (entry file only, excluding main)
  const rootGroups: { readonly pos: number; readonly items: readonly RustItem[] }[] = [];
  for (const t0 of rootLowered.typeAliases) rootGroups.push({ pos: t0.pos, items: lowerTypeAlias(ctx, t0.decl) });
  for (const i0 of rootLowered.interfaces) rootGroups.push({ pos: i0.pos, items: lowerInterface(i0.decl) });
  for (const c of rootLowered.classes) rootGroups.push({ pos: c.pos, items: lowerClass(ctx, c.decl) });
  for (const f0 of rootLowered.functions) rootGroups.push({ pos: f0.pos, items: [lowerFunction(ctx, f0.decl)] });
  rootGroups.sort((a, b) => a.pos - b.pos);
  items.push(...rootGroups.flatMap((g) => g.items));

  const mainBody: RustStmt[] = [];
  for (const st of mainFn.body!.statements) mainBody.push(...lowerStmt(ctx, st));

  const mainItem: RustItem = {
    kind: "fn",
    vis: "private",
    receiver: { kind: "none" },
    name: "main",
    params: [],
    ret: returnKind === "unit" ? unitType() : (rustReturnType ?? unitType()),
    body: mainBody,
  };
  items.push(mainItem);

  const rustProgram: RustProgram = { kind: "program", items };
  const mainRs = writeRustProgram(rustProgram, { header: ["// Generated by @tsuba/compiler (v0)"] });

  const crates = [...usedCratesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { mainRs, kernels, crates };
}
