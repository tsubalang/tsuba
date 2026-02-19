import ts from "typescript";

export type AnnotationLoweringDeps = {
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
  readonly isFromTsubaCoreLang: (ident: ts.Identifier) => boolean;
  readonly isAttrMacroType: (node: ts.Expression) => boolean;
  readonly isDeriveMacroType: (node: ts.Expression) => boolean;
};

function expressionToSegments(expr: ts.Expression): readonly string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expressionToSegments(expr.expression);
    if (!left) return undefined;
    return [...left, expr.name.text];
  }
  return undefined;
}

function parseTokensArg(deps: AnnotationLoweringDeps, expr: ts.Expression): string {
  if (!ts.isTaggedTemplateExpression(expr) || !ts.isIdentifier(expr.tag)) {
    deps.failAt(expr, "TSB3300", "attr(...) arguments must be tokens`...` in v0.");
  }
  if (expr.tag.text !== "tokens" || !deps.isFromTsubaCoreLang(expr.tag)) {
    deps.failAt(expr.tag, "TSB3301", "attr(...) arguments must use @tsuba/core tokens`...` in v0.");
  }
  const tmpl = expr.template;
  if (!ts.isNoSubstitutionTemplateLiteral(tmpl)) {
    deps.failAt(tmpl, "TSB3302", "tokens`...` must not contain substitutions in v0.");
  }
  if (tmpl.text.includes("\n") || tmpl.text.includes("\r")) {
    deps.failAt(tmpl, "TSB3303", "tokens`...` must be single-line in v0.");
  }
  return tmpl.text;
}

function parseCoreAttrMarker(deps: AnnotationLoweringDeps, expr: ts.CallExpression): string {
  if (!ts.isIdentifier(expr.expression)) {
    deps.failAt(expr, "TSB3305", "annotate(...) @tsuba/core attr markers must use attr(...).");
  }
  const callee = expr.expression;
  if (callee.text !== "attr" || !deps.isFromTsubaCoreLang(callee)) {
    deps.failAt(callee, "TSB3305", "annotate(...) @tsuba/core attr markers must use attr(...).");
  }
  const [nameArg, ...rest] = expr.arguments;
  if (!nameArg || !ts.isStringLiteral(nameArg)) {
    deps.failAt(expr, "TSB3306", "attr(name, ...) requires a string literal name in v0.");
  }
  const args = rest.map((item) => parseTokensArg(deps, item));
  if (args.length === 0) return `#[${nameArg.text}]`;
  return `#[${nameArg.text}(${args.join(", ")})]`;
}

function annotatePathFromExpr(deps: AnnotationLoweringDeps, expr: ts.Expression): string {
  const segs = expressionToSegments(expr);
  if (!segs || segs.length === 0) {
    deps.failAt(
      expr,
      "TSB3304",
      "annotate(...) only supports attr(...), AttrMacro calls, and DeriveMacro values in v0."
    );
  }
  return segs.join("::");
}

function parseAnnotateItem(
  deps: AnnotationLoweringDeps,
  item: ts.Expression
): { readonly attr?: string; readonly derive?: string } {
  if (ts.isCallExpression(item)) {
    if (ts.isIdentifier(item.expression) && item.expression.text === "attr" && deps.isFromTsubaCoreLang(item.expression)) {
      return { attr: parseCoreAttrMarker(deps, item) };
    }
    if (deps.isAttrMacroType(item.expression)) {
      if ((item.typeArguments?.length ?? 0) > 0) {
        deps.failAt(item, "TSB3304", "annotate(...) AttrMacro calls do not support type arguments in v0.");
      }
      const name = annotatePathFromExpr(deps, item.expression);
      const args = item.arguments.map((arg) => parseTokensArg(deps, arg));
      if (args.length === 0) return { attr: `#[${name}]` };
      return { attr: `#[${name}(${args.join(", ")})]` };
    }
    deps.failAt(
      item,
      "TSB3304",
      "annotate(...) only supports attr(...), AttrMacro calls, and DeriveMacro values in v0."
    );
  }

  if (deps.isDeriveMacroType(item)) {
    return { derive: annotatePathFromExpr(deps, item) };
  }

  deps.failAt(
    item,
    "TSB3304",
    "annotate(...) only supports attr(...), AttrMacro calls, and DeriveMacro values in v0."
  );
}

export function tryParseAnnotateStatement(
  deps: AnnotationLoweringDeps,
  st: ts.Statement
): { readonly target: string; readonly attrs: readonly string[] } | undefined {
  if (!ts.isExpressionStatement(st)) return undefined;
  const e = st.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
  const callee = e.expression;
  if (callee.text !== "annotate" || !deps.isFromTsubaCoreLang(callee)) return undefined;

  if (e.arguments.length < 2) {
    deps.failAt(e, "TSB3307", "annotate(target, ...) requires at least one attribute in v0.");
  }
  const [target, ...items] = e.arguments;
  if (!target || !ts.isIdentifier(target)) {
    deps.failAt(e, "TSB3308", "annotate(...) target must be an identifier in v0.");
  }

  const attrs: string[] = [];
  const derives: string[] = [];
  for (const item of items) {
    const parsed = parseAnnotateItem(deps, item);
    if (parsed.attr) attrs.push(parsed.attr);
    if (parsed.derive) derives.push(parsed.derive);
  }
  if (derives.length > 0) attrs.push(`#[derive(${derives.join(", ")})]`);
  return { target: target.text, attrs };
}
