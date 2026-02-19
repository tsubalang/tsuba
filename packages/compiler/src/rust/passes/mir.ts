import type { RustExpr, RustMatchArm, RustStmt } from "../ir.js";
import { freezeReadonlyArray } from "./contracts.js";

export type MirBlockId = number;

export type MirTerminator =
  | { readonly kind: "end" }
  | { readonly kind: "goto"; readonly target: MirBlockId }
  | { readonly kind: "return"; readonly expr?: RustExpr }
  | {
      readonly kind: "if";
      readonly cond: RustExpr;
      readonly then: readonly RustStmt[];
      readonly else?: readonly RustStmt[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "while";
      readonly cond: RustExpr;
      readonly body: readonly RustStmt[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "match";
      readonly expr: RustExpr;
      readonly arms: readonly RustMatchArm[];
      readonly next?: MirBlockId;
    }
  | {
      readonly kind: "block";
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
      current.terminator = { kind: "return", expr: st.expr };
      current = allocBlock();
      continue;
    }

    if (st.kind === "if") {
      const next = allocBlock();
      current.terminator = {
        kind: "if",
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

export function emitMirBodyToRustStmtsPass(body: MirBody): readonly RustStmt[] {
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
      out.push({ kind: "return", expr: term.expr });
      break;
    }
    if (term.kind === "if") {
      out.push({ kind: "if", cond: term.cond, then: term.then, else: term.else });
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "while") {
      out.push({ kind: "while", cond: term.cond, body: term.body });
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "match") {
      out.push({ kind: "match", expr: term.expr, arms: term.arms });
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
    if (term.kind === "block") {
      out.push({ kind: "block", body: term.body });
      if (term.next === undefined) break;
      current = term.next;
      continue;
    }
  }

  return freezeReadonlyArray(out);
}
