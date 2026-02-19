import ts from "typescript";

import type { RustItem, RustStmt, RustType } from "../ir.js";
import {
  freezeReadonlyArray,
  type MainReturnKind,
  type ShapeStructDefLike,
} from "./contracts.js";

type MainEmissionPassInput<TCtx extends { readonly inAsync?: boolean }> = {
  readonly ctx: TCtx;
  readonly mainFn: ts.FunctionDeclaration;
  readonly mainIsAsync: boolean;
  readonly runtimeKind: "none" | "tokio";
  readonly returnKind: MainReturnKind;
  readonly rustReturnType?: RustType;
  readonly rootAttrs: ReadonlyMap<string, readonly string[]>;
  readonly entryFileName: string;
};

type MainEmissionPassDeps<TCtx extends { readonly inAsync?: boolean }> = {
  readonly compareText: (a: string, b: string) => number;
  readonly lowerStmt: (ctx: TCtx, statement: ts.Statement) => readonly RustStmt[];
  readonly getShapeStructsByFile: (fileName: string) => readonly ShapeStructDefLike[];
  readonly structItemFromDef: (def: ShapeStructDefLike, attrs: readonly string[]) => RustItem;
  readonly spanFromNode: (node: ts.Node) => RustItem["span"];
  readonly unitType: () => RustType;
};

export function emitMainAndRootShapesPass<TCtx extends { readonly inAsync?: boolean }>(
  input: MainEmissionPassInput<TCtx>,
  deps: MainEmissionPassDeps<TCtx>
): readonly RustItem[] {
  const {
    ctx,
    mainFn,
    mainIsAsync,
    runtimeKind,
    returnKind,
    rustReturnType,
    rootAttrs,
    entryFileName,
  } = input;

  const mainBody: RustStmt[] = [];
  const mainCtx = { ...ctx, inAsync: mainIsAsync } as TCtx;
  for (const st of mainFn.body!.statements) {
    mainBody.push(...deps.lowerStmt(mainCtx, st));
  }

  const items: RustItem[] = [];
  const rootShapeStructs = [...deps.getShapeStructsByFile(entryFileName)].sort(
    (a, b) => a.span.start - b.span.start || deps.compareText(a.key, b.key)
  );
  for (const def of rootShapeStructs) {
    items.push(deps.structItemFromDef(def, []));
  }

  items.push({
    kind: "fn",
    span: deps.spanFromNode(mainFn),
    vis: "private",
    async: mainIsAsync,
    typeParams: [],
    receiver: { kind: "none" },
    name: "main",
    params: [],
    ret: returnKind === "unit" ? deps.unitType() : (rustReturnType ?? deps.unitType()),
    attrs: [
      ...(mainIsAsync && runtimeKind === "tokio" ? ["#[tokio::main]"] : []),
      ...(rootAttrs.get("main") ?? []),
    ],
    body: mainBody,
  });

  return freezeReadonlyArray(items);
}
