import type {
  RustExpr,
  RustGenericParam,
  RustItem,
  RustMatchPattern,
  RustParam,
  RustPattern,
  RustProgram,
  RustStmt,
  RustType,
  Span,
} from "./ir.js";

function emitSpanLine(indent: string, span: Span | undefined): string[] {
  if (!span) return [];
  return [`${indent}// tsuba-span: ${span.fileName}:${span.start}:${span.end}`];
}

function emitPath(segments: readonly string[]): string {
  return segments.join("::");
}

function emitGenericParams(typeParams: readonly RustGenericParam[]): string {
  if (typeParams.length === 0) return "";
  const parts = typeParams.map((p) => {
    if (p.bounds.length === 0) return p.name;
    return `${p.name}: ${p.bounds.map(emitType).join(" + ")}`;
  });
  return `<${parts.join(", ")}>`;
}

function emitType(ty: RustType): string {
  if (ty.kind === "unit") return "()";
  if (ty.kind === "ref") {
    const lt = ty.lifetime ? `'${ty.lifetime} ` : "";
    const mut = ty.mut ? "mut " : "";
    return `&${lt}${mut}${emitType(ty.inner)}`;
  }
  if (ty.kind === "slice") {
    return `[${emitType(ty.inner)}]`;
  }
  if (ty.kind === "array") {
    return `[${emitType(ty.inner)}; ${ty.len}]`;
  }
  if (ty.kind === "tuple") {
    if (ty.elems.length === 1) return `(${emitType(ty.elems[0]!)},)`;
    return `(${ty.elems.map(emitType).join(", ")})`;
  }
  const base = emitPath(ty.path.segments);
  if (ty.args.length === 0) return base;
  return `${base}<${ty.args.map(emitType).join(", ")}>`;
}

function emitPattern(p: RustPattern): string {
  switch (p.kind) {
    case "wild":
      return "_";
    case "ident":
      return p.name;
  }
}

function emitMatchPattern(pat: RustMatchPattern): string {
  switch (pat.kind) {
    case "wild":
      return "_";
    case "enum_struct": {
      const base = emitPath(pat.path.segments);
      if (pat.fields.length === 0) return base;
      const fields = pat.fields
        .map((f) => `${f.name}: ${emitPattern(f.bind)}`)
        .join(", ");
      return `${base} { ${fields} }`;
    }
  }
}

function emitExpr(expr: RustExpr): string {
  switch (expr.kind) {
    case "unit":
      return "()";
    case "ident":
      return expr.name;
    case "path":
      return emitPath(expr.path.segments);
    case "path_call": {
      const base = emitPath(expr.path.segments);
      const turbofish =
        expr.typeArgs.length > 0 ? `::<${expr.typeArgs.map(emitType).join(", ")}>` : "";
      return `${base}${turbofish}(${expr.args.map(emitExpr).join(", ")})`;
    }
    case "number":
      return expr.text;
    case "string":
      return JSON.stringify(expr.value);
    case "bool":
      return expr.value ? "true" : "false";
    case "paren":
      return `(${emitExpr(expr.expr)})`;
    case "array":
      return `[${expr.elems.map(emitExpr).join(", ")}]`;
    case "tuple": {
      if (expr.elems.length === 1) return `(${emitExpr(expr.elems[0]!)},)`;
      return `(${expr.elems.map(emitExpr).join(", ")})`;
    }
    case "borrow": {
      const mut = expr.mut ? "mut " : "";
      return `&${mut}(${emitExpr(expr.expr)})`;
    }
    case "cast":
      return `(${emitExpr(expr.expr)}) as ${emitType(expr.type)}`;
    case "field":
      return `${emitExpr(expr.expr)}.${expr.name}`;
    case "index":
      return `${emitExpr(expr.expr)}[${emitExpr(expr.index)}]`;
    case "binary":
      return `(${emitExpr(expr.left)} ${expr.op} ${emitExpr(expr.right)})`;
    case "call":
      return `${emitExpr(expr.callee)}(${expr.args.map(emitExpr).join(", ")})`;
    case "closure": {
      const mv = expr.move ? "move " : "";
      const params = expr.params.map((p) => `${p.name}: ${emitType(p.type)}`).join(", ");
      return `${mv}|${params}| ${emitExpr(expr.body)}`;
    }
    case "macro_call":
      return `${expr.name}!(${expr.args.map(emitExpr).join(", ")})`;
    case "assoc_call": {
      const base = emitPath(expr.typePath.segments);
      const turbofish =
        expr.typeArgs.length > 0 ? `::<${expr.typeArgs.map(emitType).join(", ")}>` : "";
      return `${base}${turbofish}::${expr.member}(${expr.args.map(emitExpr).join(", ")})`;
    }
    case "struct_lit": {
      const base = emitPath(expr.typePath.segments);
      const fields = expr.fields
        .map((f) => `${f.name}: ${emitExpr(f.expr)}`)
        .join(", ");
      return `${base} { ${fields} }`;
    }
    case "try":
      return `(${emitExpr(expr.expr)})?`;
    case "await":
      return `(${emitExpr(expr.expr)}).await`;
    case "unsafe":
      return `unsafe { ${emitExpr(expr.expr)} }`;
    case "block": {
      // v0: keep block-expressions as single-line for determinism and embedding.
      const stmtText = expr.stmts.map((s) => emitStmtInline(s)).join(" ");
      const tail = emitExpr(expr.tail);
      return `{ ${stmtText} ${tail} }`.replaceAll(/\s+/g, " ").trim();
    }
  }
}

function emitStmtInline(st: RustStmt): string {
  switch (st.kind) {
    case "let": {
      const mut = st.mut ? "mut " : "";
      const ty = st.type ? `: ${emitType(st.type)}` : "";
      return `let ${mut}${emitPattern(st.pattern)}${ty} = ${emitExpr(st.init)};`;
    }
    case "block":
      return `{ ${st.body.map((s) => emitStmtInline(s)).join(" ")} }`;
    case "assign":
      return `${emitExpr(st.target)} = ${emitExpr(st.expr)};`;
    case "expr":
      return `${emitExpr(st.expr)};`;
    case "break":
      return "break;";
    case "continue":
      return "continue;";
    case "while":
      return `while ${emitExpr(st.cond)} { ${st.body.map((s) => emitStmtInline(s)).join(" ")} }`;
    case "match": {
      const arms = st.arms
        .map((arm) => `${emitMatchPattern(arm.pattern)} => { ${arm.body.map((s) => emitStmtInline(s)).join(" ")} },`)
        .join(" ");
      return `match ${emitExpr(st.expr)} { ${arms} }`;
    }
    case "return":
      return st.expr ? `return ${emitExpr(st.expr)};` : "return;";
    case "if": {
      const thenPart = `{ ${st.then.map((s) => emitStmtInline(s)).join(" ")} }`;
      if (!st.else) return `if ${emitExpr(st.cond)} ${thenPart}`;
      const elsePart = `{ ${st.else.map((s) => emitStmtInline(s)).join(" ")} }`;
      return `if ${emitExpr(st.cond)} ${thenPart} else ${elsePart}`;
    }
  }
}

function emitStmtLines(st: RustStmt, indent: string): string[] {
  const spanLine = emitSpanLine(indent, st.span);
  switch (st.kind) {
    case "let": {
      const mut = st.mut ? "mut " : "";
      const ty = st.type ? `: ${emitType(st.type)}` : "";
      return [...spanLine, `${indent}let ${mut}${emitPattern(st.pattern)}${ty} = ${emitExpr(st.init)};`];
    }
    case "block": {
      const out: string[] = [];
      out.push(...spanLine);
      out.push(`${indent}{`);
      for (const s of st.body) out.push(...emitStmtLines(s, `${indent}  `));
      out.push(`${indent}}`);
      return out;
    }
    case "assign":
      return [...spanLine, `${indent}${emitExpr(st.target)} = ${emitExpr(st.expr)};`];
    case "expr":
      return [...spanLine, `${indent}${emitExpr(st.expr)};`];
    case "while": {
      const out: string[] = [];
      out.push(...spanLine);
      out.push(`${indent}while ${emitExpr(st.cond)} {`);
      for (const s of st.body) out.push(...emitStmtLines(s, `${indent}  `));
      out.push(`${indent}}`);
      return out;
    }
    case "break":
      return [...spanLine, `${indent}break;`];
    case "continue":
      return [...spanLine, `${indent}continue;`];
    case "return":
      return [...spanLine, st.expr ? `${indent}return ${emitExpr(st.expr)};` : `${indent}return;`];
    case "if": {
      const out: string[] = [];
      out.push(...spanLine);
      out.push(`${indent}if ${emitExpr(st.cond)} {`);
      for (const s of st.then) out.push(...emitStmtLines(s, `${indent}  `));
      if (st.else) {
        out.push(`${indent}} else {`);
        for (const s of st.else) out.push(...emitStmtLines(s, `${indent}  `));
      }
      out.push(`${indent}}`);
      return out;
    }
    case "match": {
      const out: string[] = [];
      out.push(...spanLine);
      out.push(`${indent}match ${emitExpr(st.expr)} {`);
      const armIndent = `${indent}  `;
      const bodyIndent = `${indent}    `;
      for (const arm of st.arms) {
        const pat = emitMatchPattern(arm.pattern);
        out.push(`${armIndent}${pat} => {`);
        for (const s of arm.body) out.push(...emitStmtLines(s, bodyIndent));
        out.push(`${armIndent}},`);
      }
      out.push(`${indent}}`);
      return out;
    }
  }
}

function emitParam(p: RustParam): string {
  return `${p.name}: ${emitType(p.type)}`;
}

function emitItem(item: RustItem, indent: string): string[] {
  const spanLine = emitSpanLine(indent, item.span);
  switch (item.kind) {
    case "use": {
      const alias = item.alias ? ` as ${item.alias}` : "";
      return [...spanLine, `${indent}use ${emitPath(item.path.segments)}${alias};`];
    }
    case "mod": {
      const out: string[] = [];
      out.push(...spanLine);
      out.push(`${indent}mod ${item.name} {`);
      const innerIndent = `${indent}  `;
      let first = true;
      for (const inner of item.items) {
        if (!first) out.push("");
        out.push(...emitItem(inner, innerIndent));
        first = false;
      }
      out.push(`${indent}}`);
      return out;
    }
    case "trait": {
      const out: string[] = [];
      const vis = item.vis === "pub" ? "pub " : "";
      const typeParams = emitGenericParams(item.typeParams);
      const superTraits = item.superTraits.length > 0 ? `: ${item.superTraits.map(emitType).join(" + ")}` : "";
      out.push(...spanLine);
      out.push(`${indent}${vis}trait ${item.name}${typeParams}${superTraits} {`);
      const innerIndent = `${indent}  `;
      let first = true;
      for (const inner of item.items) {
        if (!first) out.push("");
        out.push(...emitItem(inner, innerIndent));
        first = false;
      }
      out.push(`${indent}}`);
      return out;
    }
    case "enum": {
      const out: string[] = [];
      out.push(...spanLine);
      for (const a of item.attrs) out.push(`${indent}${a}`);
      const vis = item.vis === "pub" ? "pub " : "";
      out.push(`${indent}${vis}enum ${item.name} {`);
      for (const v of item.variants) {
        if (v.fields.length === 0) {
          out.push(`${indent}  ${v.name},`);
          continue;
        }
        const fields = v.fields.map((f) => `${f.name}: ${emitType(f.type)}`).join(", ");
        out.push(`${indent}  ${v.name} { ${fields} },`);
      }
      out.push(`${indent}}`);
      return out;
    }
    case "struct": {
      const out: string[] = [];
      out.push(...spanLine);
      for (const a of item.attrs) out.push(`${indent}${a}`);
      const vis = item.vis === "pub" ? "pub " : "";
      const typeParams = emitGenericParams(item.typeParams);
      if (item.fields.length === 0) {
        out.push(`${indent}${vis}struct ${item.name}${typeParams};`);
        return out;
      }
      out.push(`${indent}${vis}struct ${item.name}${typeParams} {`);
      for (const f of item.fields) {
        const fvis = f.vis === "pub" ? "pub " : "";
        out.push(`${indent}  ${fvis}${f.name}: ${emitType(f.type)},`);
      }
      out.push(`${indent}}`);
      return out;
    }
    case "impl": {
      const out: string[] = [];
      const typeParams = emitGenericParams(item.typeParams);
      const head = item.traitPath
        ? `impl${typeParams} ${emitType(item.traitPath)} for ${emitType(item.typePath)}`
        : `impl${typeParams} ${emitType(item.typePath)}`;
      out.push(...spanLine);
      out.push(`${indent}${head} {`);
      const innerIndent = `${indent}  `;
      let first = true;
      for (const inner of item.items) {
        if (!first) out.push("");
        out.push(...emitItem(inner, innerIndent));
        first = false;
      }
      out.push(`${indent}}`);
      return out;
    }
    case "fn": {
      const out: string[] = [];
      out.push(...spanLine);
      for (const a of item.attrs) out.push(`${indent}${a}`);
      const retClause = item.ret.kind === "unit" ? "" : ` -> ${emitType(item.ret)}`;
      const vis = item.vis === "pub" ? "pub " : "";
      const async = item.async ? "async " : "";
      const typeParams = emitGenericParams(item.typeParams);
      const receiver = (() => {
        if (item.receiver.kind === "none") return undefined;
        const lt = item.receiver.lifetime ? `'${item.receiver.lifetime} ` : "";
        const mut = item.receiver.mut ? "mut " : "";
        return `&${lt}${mut}self`;
      })();
      const params = receiver ? [receiver, ...item.params.map(emitParam)] : item.params.map(emitParam);
      if (!item.body) {
        out.push(`${indent}${vis}${async}fn ${item.name}${typeParams}(${params.join(", ")})${retClause};`);
        return out;
      }
      out.push(`${indent}${vis}${async}fn ${item.name}${typeParams}(${params.join(", ")})${retClause} {`);
      const bodyIndent = `${indent}  `;
      for (const st of item.body) out.push(...emitStmtLines(st, bodyIndent));
      out.push(`${indent}}`);
      return out;
    }
  }
}

export function writeRustProgram(program: RustProgram, opts?: { readonly header?: readonly string[] }): string {
  const parts: string[] = [];
  for (const h of opts?.header ?? []) parts.push(h);
  for (const item of program.items) {
    if (parts.length > 0) parts.push("");
    parts.push(...emitItem(item, ""));
  }
  parts.push("");
  return parts.join("\n");
}
