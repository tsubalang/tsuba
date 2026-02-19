import ts from "typescript";

import type { RustGenericParam, RustType } from "../ir.js";
import { pathType, unitType } from "../ir.js";

export type TypeLoweringDeps = {
  readonly failAt: (node: ts.Node, code: string, message: string) => never;
};

function entityNameToSegments(name: ts.EntityName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return [...entityNameToSegments(name.left), name.right.text];
}

const rustPrimitiveTypes = new Map<string, RustType>([
  ["i8", pathType(["i8"])],
  ["i16", pathType(["i16"])],
  ["i32", pathType(["i32"])],
  ["i64", pathType(["i64"])],
  ["i128", pathType(["i128"])],
  ["isize", pathType(["isize"])],
  ["u8", pathType(["u8"])],
  ["u16", pathType(["u16"])],
  ["u32", pathType(["u32"])],
  ["u64", pathType(["u64"])],
  ["u128", pathType(["u128"])],
  ["usize", pathType(["usize"])],
  ["f32", pathType(["f32"])],
  ["f64", pathType(["f64"])],
  ["bool", pathType(["bool"])],
  ["Str", pathType(["str"])],
  ["String", pathType(["std", "string", "String"])],
]);

export function typeNodeToRust(
  typeNode: ts.TypeNode | undefined,
  deps: TypeLoweringDeps
): RustType {
  if (!typeNode) return unitType();
  if (typeNode.kind === ts.SyntaxKind.VoidKeyword) return unitType();
  if (ts.isTypeReferenceNode(typeNode)) {
    const typeNameSegments = entityNameToSegments(typeNode.typeName);

    if (typeNameSegments.length > 0) {
      const baseName = typeNameSegments[typeNameSegments.length - 1]!;
      const mapped = typeNameSegments.length === 1 ? rustPrimitiveTypes.get(baseName) : undefined;
      if (mapped) return mapped;

      if (typeNameSegments.length === 1 && (baseName === "ref" || baseName === "mutref")) {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1016", `${baseName}<T> must have exactly one type argument.`);
        return { kind: "ref", mut: baseName === "mutref", inner: typeNodeToRust(inner, deps) };
      }

      if (typeNameSegments.length === 1 && (baseName === "refLt" || baseName === "mutrefLt")) {
        const [lt, inner] = typeNode.typeArguments ?? [];
        if (!lt || !inner) deps.failAt(typeNode, "TSB1017", `${baseName}<L,T> must have exactly two type arguments.`);
        if (!ts.isLiteralTypeNode(lt) || !ts.isStringLiteral(lt.literal)) {
          deps.failAt(lt, "TSB1018", `${baseName} lifetime must be a string literal (e.g., refLt<\"a\", T>).`);
        }
        return {
          kind: "ref",
          mut: baseName === "mutrefLt",
          lifetime: lt.literal.text,
          inner: typeNodeToRust(inner, deps),
        };
      }

      if (typeNameSegments.length === 1 && baseName === "mut") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1011", "mut<T> must have exactly one type argument.");
        return typeNodeToRust(inner, deps);
      }

      if (typeNameSegments.length === 1 && baseName === "Option") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1012", "Option<T> must have exactly one type argument.");
        return pathType(["Option"], [typeNodeToRust(inner, deps)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Result") {
        const [okTy, errTy] = typeNode.typeArguments ?? [];
        if (!okTy || !errTy) deps.failAt(typeNode, "TSB1013", "Result<T,E> must have exactly two type arguments.");
        return pathType(["Result"], [typeNodeToRust(okTy, deps), typeNodeToRust(errTy, deps)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Vec") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1014", "Vec<T> must have exactly one type argument.");
        return pathType(["Vec"], [typeNodeToRust(inner, deps)]);
      }

      if (typeNameSegments.length === 1 && baseName === "HashMap") {
        const [k, v] = typeNode.typeArguments ?? [];
        if (!k || !v) deps.failAt(typeNode, "TSB1015", "HashMap<K,V> must have exactly two type arguments.");
        return pathType(["std", "collections", "HashMap"], [typeNodeToRust(k, deps), typeNodeToRust(v, deps)]);
      }

      if (typeNameSegments.length === 1 && baseName === "Slice") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1021", "Slice<T> must have exactly one type argument.");
        return { kind: "slice", inner: typeNodeToRust(inner, deps) };
      }

      if (typeNameSegments.length === 1 && baseName === "ArrayN") {
        const [inner, lenNode] = typeNode.typeArguments ?? [];
        if (!inner || !lenNode) {
          deps.failAt(typeNode, "TSB1022", "ArrayN<T,N> must have exactly two type arguments.");
        }
        if (!ts.isLiteralTypeNode(lenNode) || !ts.isNumericLiteral(lenNode.literal)) {
          deps.failAt(lenNode, "TSB1023", "ArrayN length must be a numeric literal type (e.g., ArrayN<u8, 16>).");
        }
        const len = Number.parseInt(lenNode.literal.text, 10);
        if (!Number.isInteger(len) || len < 0) {
          deps.failAt(lenNode, "TSB1023", "ArrayN length must be a non-negative integer literal.");
        }
        return { kind: "array", inner: typeNodeToRust(inner, deps), len };
      }

      if (typeNameSegments.length === 1 && baseName === "global_ptr") {
        const [inner] = typeNode.typeArguments ?? [];
        if (!inner) deps.failAt(typeNode, "TSB1020", "global_ptr<T> must have exactly one type argument.");
        return pathType(["__tsuba_cuda", "DevicePtr"], [typeNodeToRust(inner, deps)]);
      }

      const typeArgs = (typeNode.typeArguments ?? []).map((t) => typeNodeToRust(t, deps));
      return pathType(typeNameSegments, typeArgs);
    }
  }
  if (ts.isTupleTypeNode(typeNode)) {
    const elems = typeNode.elements.map((el) =>
      ts.isNamedTupleMember(el) ? typeNodeToRust(el.type, deps) : typeNodeToRust(el, deps)
    );
    return { kind: "tuple", elems };
  }
  deps.failAt(typeNode, "TSB1010", `Unsupported type annotation: ${typeNode.getText()}`);
}

export function unwrapPromiseInnerType(
  ownerNode: ts.Node,
  ownerLabel: string,
  typeNode: ts.TypeNode | undefined,
  code: string,
  deps: TypeLoweringDeps
): ts.TypeNode {
  if (!typeNode) {
    deps.failAt(ownerNode, code, `${ownerLabel}: async functions must declare an explicit Promise<...> return type in v0.`);
  }
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName) || typeNode.typeName.text !== "Promise") {
    deps.failAt(ownerNode, code, `${ownerLabel}: async functions must return Promise<T> in v0.`);
  }
  const [inner] = typeNode.typeArguments ?? [];
  if (!inner) {
    deps.failAt(typeNode, code, `${ownerLabel}: Promise<T> must have exactly one type argument in v0.`);
  }
  return inner;
}

function lowerTypeParameter(
  checker: ts.TypeChecker,
  ownerNode: ts.Node,
  ownerLabel: string,
  p: ts.TypeParameterDeclaration,
  code: string,
  deps: TypeLoweringDeps
): RustGenericParam {
  if (!ts.isIdentifier(p.name)) {
    deps.failAt(ownerNode, code, `${ownerLabel}: unsupported generic parameter declaration in v0.`);
  }

  const bounds: RustType[] = [];
  const constraint = p.constraint;
  if (constraint) {
    const pushBound = (node: ts.TypeNode): void => {
      const ty = typeNodeToRust(node, deps);
      if (ty.kind !== "path") {
        deps.failAt(node, code, `${ownerLabel}: generic constraint must be a nominal trait/type path in v0.`);
      }
      const constraintType = checker.getTypeFromTypeNode(node);
      const symbol0 =
        constraintType.getSymbol() ??
        (constraintType as unknown as { readonly aliasSymbol?: ts.Symbol }).aliasSymbol;
      if (!symbol0) {
        deps.failAt(node, code, `${ownerLabel}: generic constraint must resolve to a trait interface in v0.`);
      }
      const symbol =
        (symbol0.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol0) : symbol0;
      const isInterface = (symbol.declarations ?? []).some((d) => ts.isInterfaceDeclaration(d));
      if (!isInterface) {
        deps.failAt(node, code, `${ownerLabel}: generic constraint must resolve to a trait interface in v0.`);
      }
      bounds.push(ty);
    };

    if (ts.isIntersectionTypeNode(constraint)) {
      if (constraint.types.length === 0) {
        deps.failAt(constraint, code, `${ownerLabel}: empty intersection constraints are not supported in v0.`);
      }
      for (const part of constraint.types) pushBound(part);
    } else {
      pushBound(constraint);
    }
  }

  return { name: p.name.text, bounds };
}

export function lowerTypeParameters(
  checker: ts.TypeChecker,
  ownerNode: ts.Node,
  ownerLabel: string,
  params: readonly ts.TypeParameterDeclaration[] | undefined,
  code: string,
  deps: TypeLoweringDeps
): readonly RustGenericParam[] {
  if (!params || params.length === 0) return [];
  return params.map((p) => lowerTypeParameter(checker, ownerNode, ownerLabel, p, code, deps));
}

export function methodReceiverFromThisParam(
  typeNode: ts.TypeNode | undefined
): { readonly mut: boolean; readonly lifetime?: string } | undefined {
  if (!typeNode) return undefined;
  if (!ts.isTypeReferenceNode(typeNode)) return undefined;
  if (!ts.isIdentifier(typeNode.typeName)) return undefined;
  const name = typeNode.typeName.text;
  if (name === "ref" || name === "mutref") return { mut: name === "mutref" };
  if (name === "refLt" || name === "mutrefLt") {
    const [lt] = typeNode.typeArguments ?? [];
    if (!lt || !ts.isLiteralTypeNode(lt) || !ts.isStringLiteral(lt.literal)) return undefined;
    return { mut: name === "mutrefLt", lifetime: lt.literal.text };
  }
  return undefined;
}

export function isMutMarkerType(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  if (!ts.isTypeReferenceNode(typeNode)) return false;
  const tn = typeNode.typeName;
  if (!ts.isIdentifier(tn)) return false;
  return tn.text === "mut";
}
