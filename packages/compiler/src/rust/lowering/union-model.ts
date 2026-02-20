import ts from "typescript";

import { unionKeyFromDecl } from "./common.js";

export type UnionLookupCtx<TUnion> = {
  readonly checker: ts.TypeChecker;
  readonly unions: Map<string, TUnion>;
};

export function unionKeyFromType(type: ts.Type): string | undefined {
  const alias = (type as unknown as { readonly aliasSymbol?: ts.Symbol }).aliasSymbol;
  if (!alias) return undefined;
  for (const d of alias.declarations ?? []) {
    if (ts.isTypeAliasDeclaration(d)) return unionKeyFromDecl(d);
  }
  return undefined;
}

export function unionDefFromType<TUnion>(
  ctx: UnionLookupCtx<TUnion>,
  type: ts.Type
): TUnion | undefined {
  const key = unionKeyFromType(type);
  return key ? ctx.unions.get(key) : undefined;
}

export function unionDefFromIdentifier<TUnion>(
  ctx: UnionLookupCtx<TUnion>,
  ident: ts.Identifier
): TUnion | undefined {
  const direct = unionDefFromType(ctx, ctx.checker.getTypeAtLocation(ident));
  if (direct) return direct;

  const symbol = ctx.checker.getSymbolAtLocation(ident);
  for (const decl of symbol?.declarations ?? []) {
    const maybeTypeNode = (() => {
      if (
        ts.isVariableDeclaration(decl) ||
        ts.isParameter(decl) ||
        ts.isPropertyDeclaration(decl) ||
        ts.isPropertySignature(decl)
      ) {
        return decl.type;
      }
      return undefined;
    })();
    if (!maybeTypeNode) continue;
    const declared = unionDefFromType(ctx, ctx.checker.getTypeFromTypeNode(maybeTypeNode));
    if (declared) return declared;
  }

  return undefined;
}
