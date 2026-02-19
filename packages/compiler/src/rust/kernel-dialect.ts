import ts from "typescript";

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

type CudaEnv = {
  readonly vars: Map<string, CudaType>;
  readonly sharedDecls: string[];
  nextSharedId: number;
};

type FailAt = (node: ts.Node, code: string, message: string) => never;

type KernelDialectOptions = {
  readonly failAt: FailAt;
  readonly isFromTsubaGpuLang: (ident: ts.Identifier) => boolean;
};

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

export function kernelDeclForIdentifier(
  checker: ts.TypeChecker,
  kernelDeclBySymbol: ReadonlyMap<ts.Symbol, KernelDecl>,
  ident: ts.Identifier
): KernelDecl | undefined {
  const sym0 = checker.getSymbolAtLocation(ident);
  const sym = resolveAliasedSymbol(checker, sym0);
  if (!sym) return undefined;
  return kernelDeclBySymbol.get(sym);
}

function cudaTypeFromTypeNode(node: ts.TypeNode, at: ts.Node, failAt: FailAt): CudaType {
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
    const inner = cudaTypeFromTypeNode(args[0]!, args[0]!, failAt);
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
    const inner = cudaTypeFromTypeNode(args[0]!, args[0]!, failAt);
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

function lowerKernelExprToCuda(env: CudaEnv, expr: ts.Expression, failAt: FailAt): { readonly text: string; readonly type: CudaType } {
  if (ts.isParenthesizedExpression(expr)) {
    const inner = lowerKernelExprToCuda(env, expr.expression, failAt);
    return { text: `(${inner.text})`, type: inner.type };
  }

  if (ts.isIdentifier(expr)) {
    const t = env.vars.get(expr.text);
    if (!t) failAt(expr, "TSB1420", `Unknown kernel identifier '${expr.text}'.`);
    return { text: expr.text, type: t };
  }

  if (ts.isAsExpression(expr)) {
    const castTy = cudaTypeFromTypeNode(expr.type, expr.type, failAt);
    if (castTy.kind !== "scalar") {
      failAt(expr.type, "TSB1423", `Only scalar casts are supported in kernel code in v0 (got ${expr.type.getText()}).`);
    }
    const innerText = (() => {
      if (ts.isNumericLiteral(expr.expression)) return expr.expression.text;
      const inner = lowerKernelExprToCuda(env, expr.expression, failAt);
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
      const elTy = cudaTypeFromTypeNode(args[0]!, args[0]!, failAt);
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
      const base = lowerKernelExprToCuda(env, expr.arguments[0]!, failAt);
      if (base.type.kind !== "ptr") {
        failAt(expr.arguments[0]!, "TSB1425", "addr(ptr, index) requires ptr to be a pointer type in v0.");
      }
      const idx = lowerKernelExprToCuda(env, expr.arguments[1]!, failAt);
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
      const ptr = lowerKernelExprToCuda(env, expr.arguments[0]!, failAt);
      if (ptr.type.kind !== "ptr" || ptr.type.inner !== "u32") {
        failAt(expr.arguments[0]!, "TSB1425", "atomicAdd(ptr, value) requires ptr to be global_ptr<u32> in v0.");
      }
      const value = lowerKernelExprToCuda(env, expr.arguments[1]!, failAt);
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
      const x = lowerKernelExprToCuda(env, expr.arguments[0]!, failAt);
      if (x.type.kind !== "scalar" || x.type.scalar !== "f32") {
        failAt(expr.arguments[0]!, "TSB1425", "expf(x) requires x to be f32 in v0.");
      }
      return { text: `expf(${x.text})`, type: { kind: "scalar", scalar: "f32" } };
    }

    if (expr.arguments.length !== 0) {
      failAt(expr, "TSB1425", `${name}(...) in kernel code is not supported in v0.`);
    }
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
    const base = lowerKernelExprToCuda(env, expr.expression, failAt);
    if (base.type.kind !== "ptr") {
      failAt(expr.expression, "TSB1428", "Element access in kernel code is only supported on pointer types in v0.");
    }
    const idx = lowerKernelExprToCuda(env, expr.argumentExpression, failAt);
    if (idx.type.kind !== "scalar" || (idx.type.scalar !== "u32" && idx.type.scalar !== "i32")) {
      failAt(expr.argumentExpression, "TSB1429", "Pointer index must be i32 or u32 in v0.");
    }
    return { text: `${base.text}[${idx.text}]`, type: { kind: "scalar", scalar: base.type.inner } };
  }

  if (ts.isBinaryExpression(expr)) {
    const left = lowerKernelExprToCuda(env, expr.left, failAt);
    const right = lowerKernelExprToCuda(env, expr.right, failAt);
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

function lowerKernelStmtToCuda(env: CudaEnv, st: ts.Statement, indent: string, failAt: FailAt): string[] {
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
      const init = lowerKernelExprToCuda(env, decl.initializer, failAt);
      const ty = decl.type ? cudaTypeFromTypeNode(decl.type, decl.type, failAt) : init.type;
      if (ty.kind !== init.type.kind || (ty.kind === "scalar" && init.type.kind === "scalar" && ty.scalar !== init.type.scalar)) {
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
        const target = lowerKernelExprToCuda(env, left, failAt);
        const value = lowerKernelExprToCuda(env, right, failAt);
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
        const value = lowerKernelExprToCuda(env, right, failAt);
        if (value.type.kind !== "scalar" || value.type.scalar !== targetTy.scalar) {
          failAt(right, "TSB1446", `Kernel scalar assignment value type must match '${left.text}' in v0.`);
        }
        return [`${indent}${left.text} = ${value.text};`];
      }

      failAt(left, "TSB1444", "Kernel assignments must be to pointer elements (p[i] = ...) or scalar variables (x = ...) in v0.");
    }
    const ex = lowerKernelExprToCuda(env, e, failAt);
    return [`${indent}${ex.text};`];
  }

  if (ts.isIfStatement(st)) {
    const cond = lowerKernelExprToCuda(env, st.expression, failAt);
    if (cond.type.kind !== "scalar" || cond.type.scalar !== "bool") {
      failAt(st.expression, "TSB1450", "Kernel if condition must be bool in v0.");
    }
    const out: string[] = [];
    out.push(`${indent}if (${cond.text}) {`);
    const thenStmts = ts.isBlock(st.thenStatement) ? st.thenStatement.statements : [st.thenStatement];
    for (const s of thenStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `, failAt));
    if (st.elseStatement) {
      out.push(`${indent}} else {`);
      const elseStmts = ts.isBlock(st.elseStatement) ? st.elseStatement.statements : [st.elseStatement];
      for (const s of elseStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `, failAt));
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
    for (const s of st.statements) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `, failAt));
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
    const init = lowerKernelExprToCuda(env, decl.initializer, failAt);
    const ty = decl.type ? cudaTypeFromTypeNode(decl.type, decl.type, failAt) : init.type;
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
    const cond = lowerKernelExprToCuda(env, st.condition, failAt);
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
        const rhs = lowerKernelExprToCuda(env, inc.right, failAt);
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
    for (const s of bodyStmts) out.push(...lowerKernelStmtToCuda(env, s, `${indent}  `, failAt));
    out.push(`${indent}}`);
    return out;
  }

  failAt(st, "TSB1460", `Unsupported kernel statement in v0: ${st.getText()}`);
}

function lowerKernelToCudaSource(
  name: string,
  fn: ts.ArrowFunction,
  specText: string,
  failAt: FailAt
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
    const ty = cudaTypeFromTypeNode(p.type, p.type, failAt);
    if (ty.kind === "ptr" && ty.addrSpace !== "global") {
      failAt(p.type, "TSB1419", "Kernel parameters may only use global_ptr<T> in v0.");
    }
    env.vars.set(p.name.text, ty);
    params.push({ name: p.name.text, ty });
  }

  const bodyStmts: readonly ts.Statement[] = (() => {
    if (ts.isBlock(fn.body)) return fn.body.statements;
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
  for (const st of bodyStmts) bodyLines.push(...lowerKernelStmtToCuda(env, st, "  ", failAt));
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

function kernelNameFromSpec(spec: ts.ObjectLiteralExpression, failAt: FailAt): string {
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
    return name;
  }
  failAt(spec, "TSB1407", "kernel spec must include a string literal 'name' field in v0.");
}

export function collectKernelDecls(
  checker: ts.TypeChecker,
  kernelDeclBySymbol: Map<ts.Symbol, KernelDecl>,
  sf: ts.SourceFile,
  seen: Set<string>,
  options: KernelDialectOptions
): readonly KernelDecl[] {
  const out: KernelDecl[] = [];
  const { failAt, isFromTsubaGpuLang } = options;

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "kernel" && isFromTsubaGpuLang(node.expression)) {
        if (
          !ts.isVariableDeclaration(node.parent) ||
          node.parent.initializer !== node ||
          !ts.isIdentifier(node.parent.name) ||
          !ts.isVariableDeclarationList(node.parent.parent)
        ) {
          failAt(node, "TSB1400", "kernel(...) must appear as a const initializer: const k = kernel(...).");
        }
        const variableDecl = node.parent as ts.VariableDeclaration & {
          readonly name: ts.Identifier;
          readonly parent: ts.VariableDeclarationList;
        };
        const declList = variableDecl.parent;
        const declStmt = declList.parent;
        if (!ts.isVariableStatement(declStmt) || declStmt.parent !== sf) {
          failAt(node, "TSB1400", "kernel(...) must be declared in a top-level const statement in v0.");
        }
        const isConst = (declList.flags & ts.NodeFlags.Const) !== 0;
        if (!isConst) failAt(declList, "TSB1401", "kernel(...) must be assigned to a const in v0.");

        if (node.arguments.length !== 2) {
          failAt(node, "TSB1403", "kernel(spec, fn) must have exactly 2 arguments in v0.");
        }
        const specArg0 = node.arguments[0];
        const fnArg0 = node.arguments[1];
        if (!specArg0 || !isAsConstObjectLiteral(specArg0)) {
          failAt(node, "TSB1404", "kernel spec must be an object literal with 'as const' in v0.");
        }
        if (!fnArg0 || !ts.isArrowFunction(fnArg0)) {
          failAt(node, "TSB1405", "kernel fn must be an arrow function in v0.");
        }
        const specArg = specArg0 as ts.AsExpression & { readonly expression: ts.ObjectLiteralExpression };
        const fnArg = fnArg0 as ts.ArrowFunction;

        const kernelName = kernelNameFromSpec(specArg.expression, failAt);
        if (seen.has(kernelName)) failAt(variableDecl.name, "TSB1402", `Duplicate kernel name '${kernelName}'.`);
        seen.add(kernelName);

        const specText = specArg.expression.getText(sf);
        const lowered = lowerKernelToCudaSource(kernelName, fnArg, specText, failAt);
        const decl: KernelDecl = { name: kernelName, specText, cuSource: lowered.cuSource, params: lowered.params };
        out.push(decl);

        const sym0 = checker.getSymbolAtLocation(variableDecl.name);
        const resolvedSym = resolveAliasedSymbol(checker, sym0);
        if (!resolvedSym) {
          failAt(variableDecl.name, "TSB1402", `Could not resolve kernel symbol for '${kernelName}'.`);
        }
        const kernelSym = resolvedSym as ts.Symbol;
        kernelDeclBySymbol.set(kernelSym, decl);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return out;
}
