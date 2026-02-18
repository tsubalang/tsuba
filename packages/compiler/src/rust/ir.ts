export type Span = {
  readonly fileName: string;
  readonly start: number;
  readonly end: number;
};

export type NodeBase = {
  readonly span?: Span;
};

export type RustPath = {
  readonly segments: readonly string[];
};

export type RustVisibility = "private" | "pub";

export type RustReceiver =
  | { readonly kind: "none" }
  | { readonly kind: "ref_self"; readonly mut: boolean; readonly lifetime?: string };

export type RustType =
  | (NodeBase & { readonly kind: "unit" })
  | (NodeBase & {
      readonly kind: "ref";
      readonly mut: boolean;
      readonly lifetime?: string;
      readonly inner: RustType;
    })
  | (NodeBase & { readonly kind: "slice"; readonly inner: RustType })
  | (NodeBase & { readonly kind: "path"; readonly path: RustPath; readonly args: readonly RustType[] });

export type RustPattern =
  | (NodeBase & { readonly kind: "wild" })
  | (NodeBase & { readonly kind: "ident"; readonly name: string });

export type RustExpr =
  | (NodeBase & { readonly kind: "unit" })
  | (NodeBase & { readonly kind: "ident"; readonly name: string })
  | (NodeBase & { readonly kind: "path"; readonly path: RustPath })
  | (NodeBase & {
      readonly kind: "path_call";
      readonly path: RustPath;
      readonly typeArgs: readonly RustType[];
      readonly args: readonly RustExpr[];
    })
  | (NodeBase & { readonly kind: "number"; readonly text: string })
  | (NodeBase & { readonly kind: "string"; readonly value: string })
  | (NodeBase & { readonly kind: "bool"; readonly value: boolean })
  | (NodeBase & { readonly kind: "paren"; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "borrow"; readonly mut: boolean; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "cast"; readonly expr: RustExpr; readonly type: RustType })
  | (NodeBase & { readonly kind: "field"; readonly expr: RustExpr; readonly name: string })
  | (NodeBase & { readonly kind: "index"; readonly expr: RustExpr; readonly index: RustExpr })
  | (NodeBase & { readonly kind: "binary"; readonly op: string; readonly left: RustExpr; readonly right: RustExpr })
  | (NodeBase & { readonly kind: "call"; readonly callee: RustExpr; readonly args: readonly RustExpr[] })
  | (NodeBase & { readonly kind: "macro_call"; readonly name: string; readonly args: readonly RustExpr[] })
  | (NodeBase & { readonly kind: "assoc_call"; readonly typePath: RustPath; readonly typeArgs: readonly RustType[]; readonly member: string; readonly args: readonly RustExpr[] })
  | (NodeBase & {
      readonly kind: "struct_lit";
      readonly typePath: RustPath;
      readonly fields: readonly { readonly name: string; readonly expr: RustExpr }[];
    })
  | (NodeBase & { readonly kind: "try"; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "unsafe"; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "block"; readonly stmts: readonly RustStmt[]; readonly tail: RustExpr });

export type RustStmt =
  | (NodeBase & {
      readonly kind: "let";
      readonly pattern: RustPattern;
      readonly mut: boolean;
      readonly type?: RustType;
      readonly init: RustExpr;
    })
  | (NodeBase & { readonly kind: "block"; readonly body: readonly RustStmt[] })
  | (NodeBase & { readonly kind: "assign"; readonly target: RustExpr; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "expr"; readonly expr: RustExpr })
  | (NodeBase & { readonly kind: "while"; readonly cond: RustExpr; readonly body: readonly RustStmt[] })
  | (NodeBase & { readonly kind: "break" })
  | (NodeBase & { readonly kind: "continue" })
  | (NodeBase & {
      readonly kind: "match";
      readonly expr: RustExpr;
      readonly arms: readonly RustMatchArm[];
    })
  | (NodeBase & { readonly kind: "return"; readonly expr?: RustExpr })
  | (NodeBase & {
      readonly kind: "if";
      readonly cond: RustExpr;
      readonly then: readonly RustStmt[];
      readonly else?: readonly RustStmt[];
    });

export type RustParam = NodeBase & { readonly name: string; readonly type: RustType };

export type RustStructField = NodeBase & {
  readonly vis: RustVisibility;
  readonly name: string;
  readonly type: RustType;
};

export type RustEnumVariant = NodeBase & {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly type: RustType }[];
};

export type RustMatchPattern =
  | (NodeBase & { readonly kind: "wild" })
  | (NodeBase & {
      readonly kind: "enum_struct";
      readonly path: RustPath;
      readonly fields: readonly { readonly name: string; readonly bind: RustPattern }[];
    });

export type RustMatchArm = NodeBase & {
  readonly pattern: RustMatchPattern;
  readonly body: readonly RustStmt[];
};

export type RustItem =
  | (NodeBase & {
      readonly kind: "use";
      readonly path: RustPath;
      readonly alias?: string;
    })
  | (NodeBase & {
      readonly kind: "mod";
      readonly name: string;
      readonly items: readonly RustItem[];
    })
  | (NodeBase & {
      readonly kind: "trait";
      readonly vis: RustVisibility;
      readonly name: string;
      readonly items: readonly RustItem[];
    })
  | (NodeBase & {
      readonly kind: "enum";
      readonly vis: RustVisibility;
      readonly name: string;
      readonly attrs: readonly string[];
      readonly variants: readonly RustEnumVariant[];
    })
  | (NodeBase & {
      readonly kind: "struct";
      readonly vis: RustVisibility;
      readonly name: string;
      readonly attrs: readonly string[];
      readonly fields: readonly RustStructField[];
    })
  | (NodeBase & {
      readonly kind: "impl";
      readonly traitPath?: RustPath;
      readonly typePath: RustPath;
      readonly items: readonly RustItem[];
    })
  | (NodeBase & {
      readonly kind: "fn";
      readonly vis: RustVisibility;
      readonly receiver: RustReceiver;
      readonly name: string;
      readonly params: readonly RustParam[];
      readonly ret: RustType;
      readonly attrs: readonly string[];
      readonly body: readonly RustStmt[];
    });

export type RustProgram = NodeBase & {
  readonly kind: "program";
  readonly items: readonly RustItem[];
};

export function unitType(): RustType {
  return { kind: "unit" };
}

export function pathType(segments: readonly string[], args: readonly RustType[] = []): RustType {
  return { kind: "path", path: { segments }, args };
}

export function unitExpr(): RustExpr {
  return { kind: "unit" };
}

export function identExpr(name: string): RustExpr {
  return { kind: "ident", name };
}

export function pathExpr(segments: readonly string[]): RustExpr {
  return { kind: "path", path: { segments } };
}
