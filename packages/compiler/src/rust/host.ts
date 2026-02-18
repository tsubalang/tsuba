import ts from "typescript";

export type CompileIssue = {
  readonly code: string;
  readonly message: string;
};

export class CompileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CompileError";
  }
}

export type CompileHostOptions = {
  readonly entryFile: string;
};

export type CompileHostOutput = {
  readonly mainRs: string;
};

type EmitCtx = {
  readonly checker: ts.TypeChecker;
};

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
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

const rustPrimitiveTypes = new Map<string, string>([
  ["i8", "i8"],
  ["i16", "i16"],
  ["i32", "i32"],
  ["i64", "i64"],
  ["isize", "isize"],
  ["u8", "u8"],
  ["u16", "u16"],
  ["u32", "u32"],
  ["u64", "u64"],
  ["usize", "usize"],
  ["f32", "f32"],
  ["f64", "f64"],
  ["bool", "bool"],
  ["String", "std::string::String"],
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
    if (!st.body) fail("TSB1001", "export function main must have a body.");
    if (st.parameters.length !== 0) fail("TSB1002", "main() parameters are not supported in v0.");
    return st;
  }
  fail("TSB1000", "Entry file must export function main().");
}

function getOtherFunctionDecls(sf: ts.SourceFile): readonly ts.FunctionDeclaration[] {
  const out: ts.FunctionDeclaration[] = [];
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st)) continue;
    if (!st.name) continue;
    if (st.name.text === "main") continue;
    if (!st.body) continue;
    out.push(st);
  }
  return out;
}

function typeNodeToRust(typeNode: ts.TypeNode | undefined): string {
  if (!typeNode) return "()";
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return "()";
  if (ts.isTypeReferenceNode(typeNode)) {
    const tn = typeNode.typeName;
    if (ts.isIdentifier(tn)) {
      const mapped = rustPrimitiveTypes.get(tn.text);
      if (mapped) return mapped;

      // mut<T> marker -> let mut + T
      if (tn.text === "mut") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) fail("TSB1011", "mut<T> must have exactly one type argument.");
        return typeNodeToRust(inner);
      }

      if (tn.text === "Option") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) fail("TSB1012", "Option<T> must have exactly one type argument.");
        return `Option<${typeNodeToRust(inner)}>`;
      }

      if (tn.text === "Result") {
        const [okTy, errTy] = typeNode.typeArguments ?? [];
        if (!okTy || !errTy) fail("TSB1013", "Result<T,E> must have exactly two type arguments.");
        return `Result<${typeNodeToRust(okTy)}, ${typeNodeToRust(errTy)}>`;
      }

      if (tn.text === "Vec") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) fail("TSB1014", "Vec<T> must have exactly one type argument.");
        return `Vec<${typeNodeToRust(inner)}>`;
      }

      if (tn.text === "HashMap") {
        const [k, v] = typeNode.typeArguments ?? [];
        if (!k || !v) fail("TSB1015", "HashMap<K,V> must have exactly two type arguments.");
        return `std::collections::HashMap<${typeNodeToRust(k)}, ${typeNodeToRust(v)}>`;
      }
    }
  }
  fail("TSB1010", `Unsupported type annotation: ${typeNode.getText()}`);
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

function emitExpr(ctx: EmitCtx, expr: ts.Expression): string {
  if (ts.isParenthesizedExpression(expr)) return `(${emitExpr(ctx, expr.expression)})`;

  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (ts.isStringLiteral(expr)) return JSON.stringify(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return "false";

  if (ts.isVoidExpression(expr)) {
    const inner = emitExpr(ctx, expr.expression);
    return `{ let _ = ${inner}; () }`;
  }

  if (ts.isAsExpression(expr)) {
    const inner = emitExpr(ctx, expr.expression);
    const ty = typeNodeToRust(expr.type);
    return `(${inner}) as ${ty}`;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return `${emitExpr(ctx, expr.expression)}.${expr.name.text}`;
  }

  if (ts.isBinaryExpression(expr)) {
    const left = emitExpr(ctx, expr.left);
    const right = emitExpr(ctx, expr.right);
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return `${left} + ${right}`;
      case ts.SyntaxKind.MinusToken:
        return `${left} - ${right}`;
      case ts.SyntaxKind.AsteriskToken:
        return `${left} * ${right}`;
      case ts.SyntaxKind.SlashToken:
        return `${left} / ${right}`;
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return `${left} == ${right}`;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return `${left} != ${right}`;
      case ts.SyntaxKind.LessThanToken:
        return `${left} < ${right}`;
      case ts.SyntaxKind.LessThanEqualsToken:
        return `${left} <= ${right}`;
      case ts.SyntaxKind.GreaterThanToken:
        return `${left} > ${right}`;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return `${left} >= ${right}`;
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return `${left} && ${right}`;
      case ts.SyntaxKind.BarBarToken:
        return `${left} || ${right}`;
      default:
        fail("TSB1200", `Unsupported binary operator: ${expr.operatorToken.getText()}`);
    }
  }

  if (ts.isCallExpression(expr)) {
    // std prelude helpers
    if (ts.isIdentifier(expr.expression) && isFromTsubaStdPrelude(ctx, expr.expression)) {
      if (expr.expression.text === "Ok") {
        if (expr.arguments.length === 0) return "Ok(())";
        if (
          expr.arguments.length === 1 &&
          ts.isIdentifier(expr.arguments[0]!) &&
          expr.arguments[0]!.text === "undefined"
        ) {
          return "Ok(())";
        }
      }
    }

    // Core markers (compile-time only)
    if (ts.isIdentifier(expr.expression) && isFromTsubaCoreLang(ctx, expr.expression)) {
      if (expr.expression.text === "q") {
        if (expr.arguments.length !== 1) fail("TSB1300", "q(...) must have exactly one argument.");
        const inner = emitExpr(ctx, expr.arguments[0]!);
        return `(${inner})?`;
      }
      if (expr.expression.text === "unsafe") {
        if (expr.arguments.length !== 1) {
          fail("TSB1302", "unsafe(...) must have exactly one argument.");
        }
        const [arg] = expr.arguments;
        if (!arg || !ts.isArrowFunction(arg)) {
          fail("TSB1303", "unsafe(...) requires an arrow function argument in v0.");
        }
        if (ts.isBlock(arg.body)) {
          fail("TSB1304", "unsafe(() => { ... }) blocks are not supported in v0 (use expression body).");
        }
        const inner = emitExpr(ctx, arg.body);
        return `unsafe { ${inner} }`;
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

        const typeArgs = expr.typeArguments ?? [];
        const genericPart =
          typeArgs.length > 0
            ? `::<${typeArgs.map((t) => typeNodeToRust(t)).join(", ")}>`
            : "";

        const args = expr.arguments.map((a) => emitExpr(ctx, a)).join(", ");
        return `${baseRust}${genericPart}::${member}(${args})`;
      }
    }

    const args = expr.arguments.map((a) => emitExpr(ctx, a)).join(", ");

    if (isMacroType(ctx.checker, expr.expression)) {
      if (!ts.isIdentifier(expr.expression)) {
        fail("TSB1301", "Macro calls must use an identifier callee in v0.");
      }
      return `${expr.expression.text}!(${args})`;
    }

    const callee = emitExpr(ctx, expr.expression);
    return `${callee}(${args})`;
  }

  fail("TSB1100", `Unsupported expression: ${expr.getText()}`);
}

function emitStmt(ctx: EmitCtx, st: ts.Statement, indent: string): string[] {
  if (ts.isVariableStatement(st)) {
    const declKind = st.declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
    void declKind;
    const lines: string[] = [];
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) fail("TSB2001", "Destructuring declarations are not supported in v0.");
      if (!decl.initializer) fail("TSB2002", `Variable '${decl.name.text}' must have an initializer in v0.`);

      const isMut = isMutMarkerType(decl.type);
      const rustTy = decl.type && !isMut ? typeNodeToRust(decl.type) : undefined;
      const init = emitExpr(ctx, decl.initializer);

      if (rustTy) {
        lines.push(`${indent}let ${decl.name.text}: ${rustTy} = ${init};`);
      } else if (isMut && decl.type && ts.isTypeReferenceNode(decl.type)) {
        const inner = decl.type.typeArguments?.[0];
        if (!inner) fail("TSB2010", "mut<T> must have exactly one type argument.");
        const innerTy = typeNodeToRust(inner);
        lines.push(`${indent}let mut ${decl.name.text}: ${innerTy} = ${init};`);
      } else {
        lines.push(`${indent}let ${decl.name.text} = ${init};`);
      }
    }
    return lines;
  }

  if (ts.isExpressionStatement(st)) {
    return [`${indent}${emitExpr(ctx, st.expression)};`];
  }

  if (ts.isReturnStatement(st)) {
    if (!st.expression) return [`${indent}return;`];
    return [`${indent}return ${emitExpr(ctx, st.expression)};`];
  }

  if (ts.isIfStatement(st)) {
    const cond = emitExpr(ctx, st.expression);
    const thenLines = emitStmtBlock(ctx, st.thenStatement, indent);
    const elseLines = st.elseStatement ? emitStmtBlock(ctx, st.elseStatement, indent) : undefined;

    const out: string[] = [];
    out.push(`${indent}if ${cond} {`);
    out.push(...thenLines);
    if (elseLines) {
      out.push(`${indent}} else {`);
      out.push(...elseLines);
    }
    out.push(`${indent}}`);
    return out;
  }

  fail("TSB2100", `Unsupported statement: ${st.getText()}`);
}

function emitStmtBlock(ctx: EmitCtx, st: ts.Statement, indent: string): string[] {
  const innerIndent = `${indent}  `;
  if (ts.isBlock(st)) {
    const lines: string[] = [];
    for (const s of st.statements) lines.push(...emitStmt(ctx, s, innerIndent));
    return lines;
  }
  return emitStmt(ctx, st, innerIndent);
}

function emitFunction(ctx: EmitCtx, fnDecl: ts.FunctionDeclaration): string {
  if (!fnDecl.name) fail("TSB3000", "Unnamed functions are not supported in v0.");
  if (!fnDecl.body) fail("TSB3001", `Function '${fnDecl.name.text}' must have a body in v0.`);

  const params: string[] = [];
  for (const p of fnDecl.parameters) {
    if (!ts.isIdentifier(p.name)) {
      fail("TSB3002", `Function '${fnDecl.name.text}': destructuring params are not supported in v0.`);
    }
    if (!p.type) {
      fail("TSB3003", `Function '${fnDecl.name.text}': parameter '${p.name.text}' needs a type annotation in v0.`);
    }
    if (p.questionToken || p.initializer) {
      fail("TSB3004", `Function '${fnDecl.name.text}': optional/default params are not supported in v0.`);
    }
    const ty = typeNodeToRust(p.type);
    params.push(`${p.name.text}: ${ty}`);
  }

  const ret = typeNodeToRust(fnDecl.type);
  const retClause = ret === "()" ? "" : ` -> ${ret}`;

  const bodyLines: string[] = [];
  for (const st of fnDecl.body.statements) bodyLines.push(...emitStmt(ctx, st, "  "));

  return [
    `fn ${fnDecl.name.text}(${params.join(", ")})${retClause} {`,
    ...bodyLines,
    "}",
    "",
  ].join("\n");
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

  const rustReturnType =
    returnKind === "result" ? typeNodeToRust(returnTypeNode) : undefined;

  const ctx: EmitCtx = { checker };
  const helperFns = getOtherFunctionDecls(sf).map((f) => emitFunction(ctx, f)).join("");

  const bodyLines: string[] = [];
  for (const st of mainFn.body!.statements) bodyLines.push(...emitStmt(ctx, st, "  "));

  const mainRsParts: string[] = ["// Generated by @tsuba/compiler (v0)", ""];
  if (helperFns.length > 0) {
    mainRsParts.push(helperFns.trimEnd(), "");
  }
  mainRsParts.push(
    returnKind === "unit" ? "fn main() {" : `fn main() -> ${rustReturnType} {`,
    ...bodyLines,
    "}",
    ""
  );

  const mainRs = mainRsParts.join("\n");

  return { mainRs };
}
