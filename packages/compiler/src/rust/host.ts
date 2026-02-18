import ts from "typescript";

import type { RustExpr, RustItem, RustParam, RustProgram, RustStmt, RustType, Span } from "./ir.js";
import { identExpr, pathType, unitExpr, unitType } from "./ir.js";
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

export type CompileHostOutput = {
  readonly mainRs: string;
  readonly kernels: readonly KernelDecl[];
};

type EmitCtx = {
  readonly checker: ts.TypeChecker;
};

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

function splitRustPath(path: string): readonly string[] {
  return path.split("::").filter((s) => s.length > 0);
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
    return { kind: "field", expr: lowerExpr(ctx, expr.expression), name: expr.name.text };
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

function lowerStmt(ctx: EmitCtx, st: ts.Statement): RustStmt[] {
  if (ts.isVariableStatement(st)) {
    const out: RustStmt[] = [];
    for (const decl of st.declarationList.declarations) {
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

  if (ts.isExpressionStatement(st)) {
    return [{ kind: "expr", expr: lowerExpr(ctx, st.expression) }];
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

  return { kind: "fn", name: fnDecl.name.text, params, ret, body };
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

  const ctx: EmitCtx = { checker };
  const kernels = collectKernelDecls(ctx, sf);

  // Collect helper functions from all user source files (entry + its imports),
  // ignoring type-only and ambient declarations.
  const helperFnDecls: { readonly fileName: string; readonly pos: number; readonly decl: ts.FunctionDeclaration }[] =
    [];
  const seenFnNames = new Map<string, string>();

  const userSourceFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !isInNodeModules(f.fileName));

  for (const f of userSourceFiles) {
    for (const st of f.statements) {
      if (
        ts.isImportDeclaration(st) ||
        ts.isExportDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isEmptyStatement(st)
      ) {
        continue;
      }

      if (ts.isVariableStatement(st)) {
        if (hasModifier(st, ts.SyntaxKind.DeclareKeyword)) continue;

        // Allow kernel declarations (compile-time only):
        //   const k = kernel({ ... } as const, (...) => ...)
        const declList = st.declarationList;
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) fail("TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);

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

        fail("TSB3100", `Unsupported top-level variable statement: ${st.getText()}`);
      }

      if (ts.isFunctionDeclaration(st)) {
        if (!st.body) continue; // ambient
        if (!st.name) fail("TSB3000", "Unnamed functions are not supported in v0.");
        if (st.name.text === "main" && f === sf) continue;

        const prev = seenFnNames.get(st.name.text);
        if (prev) fail("TSB3101", `Duplicate function '${st.name.text}' in ${prev} and ${f.fileName}.`);
        seenFnNames.set(st.name.text, f.fileName);

        helperFnDecls.push({ fileName: f.fileName, pos: st.pos, decl: st });
        continue;
      }

      fail("TSB3102", `Unsupported top-level statement: ${st.getText()}`);
    }
  }

  helperFnDecls.sort((a, b) => {
    const fa = normalizePath(a.fileName);
    const fb = normalizePath(b.fileName);
    if (fa !== fb) return fa.localeCompare(fb);
    return a.pos - b.pos;
  });

  const items: RustItem[] = [];
  if (kernels.length > 0) {
    items.push({ kind: "struct", name: "__tsuba_kernel_placeholder", attrs: ["#[allow(dead_code)]"] });
  }

  for (const h of helperFnDecls) items.push(lowerFunction(ctx, h.decl));

  const mainBody: RustStmt[] = [];
  for (const st of mainFn.body!.statements) mainBody.push(...lowerStmt(ctx, st));

  const mainItem: RustItem = {
    kind: "fn",
    name: "main",
    params: [],
    ret: returnKind === "unit" ? unitType() : (rustReturnType ?? unitType()),
    body: mainBody,
  };
  items.push(mainItem);

  const rustProgram: RustProgram = { kind: "program", items };
  const mainRs = writeRustProgram(rustProgram, { header: ["// Generated by @tsuba/compiler (v0)"] });

  return { mainRs, kernels };
}
