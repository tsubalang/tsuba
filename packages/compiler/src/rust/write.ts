import type {
  RustExpr,
  RustItem,
  RustParam,
  RustPattern,
  RustProgram,
  RustStmt,
  RustType,
} from "./ir.js";

function emitPath(segments: readonly string[]): string {
  return segments.join("::");
}

function emitType(ty: RustType): string {
  if (ty.kind === "unit") return "()";
  if (ty.kind === "ref") {
    const lt = ty.lifetime ? `'${ty.lifetime} ` : "";
    const mut = ty.mut ? "mut " : "";
    return `&${lt}${mut}${emitType(ty.inner)}`;
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

function emitExpr(expr: RustExpr): string {
  switch (expr.kind) {
    case "unit":
      return "()";
    case "ident":
      return expr.name;
    case "path":
      return emitPath(expr.path.segments);
    case "number":
      return expr.text;
    case "string":
      return JSON.stringify(expr.value);
    case "bool":
      return expr.value ? "true" : "false";
    case "paren":
      return `(${emitExpr(expr.expr)})`;
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
      return "__tsuba_unreachable_inline_block__;";
    case "assign":
      return `${emitExpr(st.target)} = ${emitExpr(st.expr)};`;
    case "expr":
      return `${emitExpr(st.expr)};`;
    case "break":
      return "break;";
    case "continue":
      return "continue;";
    case "while":
      return "__tsuba_unreachable_inline_while__;";
    case "match":
      return "__tsuba_unreachable_inline_match__;";
    case "return":
      return st.expr ? `return ${emitExpr(st.expr)};` : "return;";
    case "if":
      // Inline-if is never used inside expression blocks in v0.
      return "__tsuba_unreachable_inline_if__;";
  }
}

function emitStmtLines(st: RustStmt, indent: string): string[] {
  switch (st.kind) {
    case "let": {
      const mut = st.mut ? "mut " : "";
      const ty = st.type ? `: ${emitType(st.type)}` : "";
      return [`${indent}let ${mut}${emitPattern(st.pattern)}${ty} = ${emitExpr(st.init)};`];
    }
    case "block": {
      const out: string[] = [];
      out.push(`${indent}{`);
      for (const s of st.body) out.push(...emitStmtLines(s, `${indent}  `));
      out.push(`${indent}}`);
      return out;
    }
    case "assign":
      return [`${indent}${emitExpr(st.target)} = ${emitExpr(st.expr)};`];
    case "expr":
      return [`${indent}${emitExpr(st.expr)};`];
    case "while": {
      const out: string[] = [];
      out.push(`${indent}while ${emitExpr(st.cond)} {`);
      for (const s of st.body) out.push(...emitStmtLines(s, `${indent}  `));
      out.push(`${indent}}`);
      return out;
    }
    case "break":
      return [`${indent}break;`];
    case "continue":
      return [`${indent}continue;`];
    case "return":
      return [st.expr ? `${indent}return ${emitExpr(st.expr)};` : `${indent}return;`];
    case "if": {
      const out: string[] = [];
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
      out.push(`${indent}match ${emitExpr(st.expr)} {`);
      const armIndent = `${indent}  `;
      const bodyIndent = `${indent}    `;
      for (const arm of st.arms) {
        const pat = (() => {
          switch (arm.pattern.kind) {
            case "wild":
              return "_";
            case "enum_struct": {
              const base = emitPath(arm.pattern.path.segments);
              if (arm.pattern.fields.length === 0) return base;
              const fields = arm.pattern.fields
                .map((f) => `${f.name}: ${emitPattern(f.bind)}`)
                .join(", ");
              return `${base} { ${fields} }`;
            }
          }
        })();
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
  switch (item.kind) {
    case "use": {
      const alias = item.alias ? ` as ${item.alias}` : "";
      return [`${indent}use ${emitPath(item.path.segments)}${alias};`];
    }
    case "mod": {
      const out: string[] = [];
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
      out.push(`${indent}${vis}trait ${item.name} {`);
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
      for (const a of item.attrs) out.push(`${indent}${a}`);
      const vis = item.vis === "pub" ? "pub " : "";
      if (item.fields.length === 0) {
        out.push(`${indent}${vis}struct ${item.name};`);
        return out;
      }
      out.push(`${indent}${vis}struct ${item.name} {`);
      for (const f of item.fields) {
        const fvis = f.vis === "pub" ? "pub " : "";
        out.push(`${indent}  ${fvis}${f.name}: ${emitType(f.type)},`);
      }
      out.push(`${indent}}`);
      return out;
    }
    case "impl": {
      const out: string[] = [];
      const head = item.traitPath
        ? `impl ${emitPath(item.traitPath.segments)} for ${emitPath(item.typePath.segments)}`
        : `impl ${emitPath(item.typePath.segments)}`;
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
      const retClause = item.ret.kind === "unit" ? "" : ` -> ${emitType(item.ret)}`;
      const vis = item.vis === "pub" ? "pub " : "";
      const receiver = (() => {
        if (item.receiver.kind === "none") return undefined;
        const lt = item.receiver.lifetime ? `'${item.receiver.lifetime} ` : "";
        const mut = item.receiver.mut ? "mut " : "";
        return `&${lt}${mut}self`;
      })();
      const params = receiver ? [receiver, ...item.params.map(emitParam)] : item.params.map(emitParam);
      out.push(`${indent}${vis}fn ${item.name}(${params.join(", ")})${retClause} {`);
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
