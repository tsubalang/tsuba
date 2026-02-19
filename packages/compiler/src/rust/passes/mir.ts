import type { RustExpr, RustMatchArm, RustStmt, Span } from "../ir.js";
import { freezeReadonlyArray } from "./contracts.js";

export type MirBlockId = number;

export type MirTerminator =
  | { readonly kind: "end" }
  | { readonly kind: "goto"; readonly target: MirBlockId }
  | { readonly kind: "return"; readonly span?: Span; readonly expr?: RustExpr }
  | {
      readonly kind: "if";
      readonly span?: Span;
      readonly cond: RustExpr;
      readonly then: readonly RustStmt[];
      readonly else?: readonly RustStmt[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "while";
      readonly span?: Span;
      readonly cond: RustExpr;
      readonly body: readonly RustStmt[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "match";
      readonly span?: Span;
      readonly expr: RustExpr;
      readonly arms: readonly RustMatchArm[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "block";
      readonly span?: Span;
      readonly body: readonly RustStmt[];
      readonly next?: MirBlockId;
    };

export type MirBlock = {
  readonly id: MirBlockId;
  readonly stmts: readonly RustStmt[];
  readonly terminator: MirTerminator;
};

export type MirBody = {
  readonly entry: MirBlockId;
  readonly blocks: readonly MirBlock[];
};

function withOptionalSpan<T extends object>(item: T, span: Span | undefined): T | (T & { readonly span: Span }) {
  if (span === undefined) return item;
  return { ...item, span };
}

function backfillStmtSpansFromSource(
  emitted: readonly RustStmt[],
  source: readonly RustStmt[]
): readonly RustStmt[] {
  if (emitted.length !== source.length) return emitted;

  let changed = false;
  const out: RustStmt[] = [];

  for (let i = 0; i < emitted.length; i++) {
    const dst = emitted[i]!;
    const src = source[i]!;

    if (dst.kind !== src.kind) {
      out.push(dst);
      continue;
    }

    let next: RustStmt = dst;

    if (dst.span === undefined && src.span !== undefined) {
      next = { ...next, span: src.span } as RustStmt;
      changed = true;
    }

    if (dst.kind === "block" && src.kind === "block") {
      const body = backfillStmtSpansFromSource(dst.body, src.body);
      if (body !== dst.body) {
        next = { ...next, body } as RustStmt;
        changed = true;
      }
      out.push(next);
      continue;
    }

    if (dst.kind === "if" && src.kind === "if") {
      const then = backfillStmtSpansFromSource(dst.then, src.then);
      const elseBody =
        dst.else !== undefined && src.else !== undefined ? backfillStmtSpansFromSource(dst.else, src.else) : dst.else;
      if (then !== dst.then || elseBody !== dst.else) {
        next = { ...next, then, else: elseBody } as RustStmt;
        changed = true;
      }
      out.push(next);
      continue;
    }

    if (dst.kind === "while" && src.kind === "while") {
      const body = backfillStmtSpansFromSource(dst.body, src.body);
      if (body !== dst.body) {
        next = { ...next, body } as RustStmt;
        changed = true;
      }
      out.push(next);
      continue;
    }

    if (dst.kind === "match" && src.kind === "match" && dst.arms.length === src.arms.length) {
      let armsChanged = false;
      const arms: RustMatchArm[] = [];
      for (let armIndex = 0; armIndex < dst.arms.length; armIndex++) {
        const dstArm = dst.arms[armIndex]!;
        const srcArm = src.arms[armIndex]!;
        let nextArm = dstArm;

        if (dstArm.span === undefined && srcArm.span !== undefined) {
          nextArm = { ...nextArm, span: srcArm.span };
          armsChanged = true;
        }

        const armBody = backfillStmtSpansFromSource(dstArm.body, srcArm.body);
        if (armBody !== dstArm.body) {
          nextArm = { ...nextArm, body: armBody };
          armsChanged = true;
        }
        arms.push(nextArm);
      }

      if (armsChanged) {
        next = { ...next, arms: freezeReadonlyArray(arms) } as RustStmt;
        changed = true;
      }
      out.push(next);
      continue;
    }

    out.push(next);
  }

  if (!changed) return emitted;
  return freezeReadonlyArray(out);
}

function newBlock(id: number): { id: number; stmts: RustStmt[]; terminator: MirTerminator } {
  return { id, stmts: [], terminator: { kind: "end" } };
}

export function lowerRustBodyToMirPass(stmts: readonly RustStmt[]): MirBody {
  const blocks: { id: number; stmts: RustStmt[]; terminator: MirTerminator }[] = [];
  let nextId = 0;

  const allocBlock = (): { id: number; stmts: RustStmt[]; terminator: MirTerminator } => {
    const b = newBlock(nextId++);
    blocks.push(b);
    return b;
  };

  let current = allocBlock();

  for (const st of stmts) {
    if (st.kind === "let" || st.kind === "assign" || st.kind === "expr" || st.kind === "break" || st.kind === "continue") {
      current.stmts.push(st);
      continue;
    }

    if (st.kind === "return") {
      current.terminator = { kind: "return", span: st.span, expr: st.expr };
      current = allocBlock();
      continue;
    }

    if (st.kind === "if") {
      const next = allocBlock();
      current.terminator = {
        kind: "if",
        span: st.span,
        cond: st.cond,
        then: st.then,
        else: st.else,
        next: next.id,
      };
      current = next;
      continue;
    }

    if (st.kind === "while") {
      const next = allocBlock();
      current.terminator = {
        kind: "while",
        span: st.span,
        cond: st.cond,
        body: st.body,
        next: next.id,
      };
      current = next;
      continue;
    }

    if (st.kind === "match") {
      const next = allocBlock();
      current.terminator = {
        kind: "match",
        span: st.span,
        expr: st.expr,
        arms: st.arms,
        next: next.id,
      };
      current = next;
      continue;
    }

    if (st.kind === "block") {
      const next = allocBlock();
      current.terminator = {
        kind: "block",
        span: st.span,
        body: st.body,
        next: next.id,
      };
      current = next;
      continue;
    }
  }

  if (current.stmts.length === 0 && current.terminator.kind === "end" && blocks.length > 1) {
    blocks.pop();
    const prev = blocks[blocks.length - 1];
    if (prev && prev.terminator.kind === "goto" && prev.terminator.target === current.id) {
      prev.terminator = { kind: "end" };
    } else if (prev && prev.terminator.kind !== "return" && prev.terminator.kind !== "end") {
      if ("next" in prev.terminator && prev.terminator.next === current.id) {
        prev.terminator = { ...prev.terminator, next: undefined };
      }
    }
  }

  const frozenBlocks = blocks.map((b) =>
    Object.freeze({
      id: b.id,
      stmts: freezeReadonlyArray(b.stmts),
      terminator: Object.freeze(b.terminator),
    })
  );
  return Object.freeze({ entry: 0, blocks: freezeReadonlyArray(frozenBlocks) });
}

export function emitMirBodyToRustStmtsPass(
  body: MirBody,
  options?: { readonly fallbackSpanSource?: readonly RustStmt[] }
): readonly RustStmt[] {
  const byId = new Map<number, MirBlock>(body.blocks.map((b) => [b.id, b]));
  const out: RustStmt[] = [];
  const visited = new Set<number>();
  let current = body.entry;

  while (true) {
    const block = byId.get(current);
    if (!block) break;
    if (visited.has(current)) break;
    visited.add(current);

    out.push(...block.stmts);
    const term = block.terminator;
    if (term.kind === "end") break;
    if (term.kind === "goto") {
      current = term.target;
      continue;
    }
    if (term.kind === "return") {
      out.push(withOptionalSpan({ kind: "return", expr: term.expr }, term.span));
      break;
    }
    if (term.kind === "if") {
      out.push(withOptionalSpan({ kind: "if", cond: term.cond, then: term.then, else: term.else }, term.span));
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "while") {
      out.push(withOptionalSpan({ kind: "while", cond: term.cond, body: term.body }, term.span));
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "match") {
      out.push(withOptionalSpan({ kind: "match", expr: term.expr, arms: term.arms }, term.span));
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "block") {
      out.push(withOptionalSpan({ kind: "block", body: term.body }, term.span));
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
  }

  const emitted = freezeReadonlyArray(out);
  if (!options?.fallbackSpanSource) return emitted;
  return backfillStmtSpansFromSource(emitted, options.fallbackSpanSource);
}
