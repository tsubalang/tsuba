import ts from "typescript";

import type { RustItem, RustType, Span } from "../ir.js";

export type MainReturnKind = "unit" | "result";

class ReadonlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #inner: ReadonlyMap<K, V>;

  constructor(inner: ReadonlyMap<K, V>) {
    this.#inner = inner;
  }

  get size(): number {
    return this.#inner.size;
  }

  get(key: K): V | undefined {
    return this.#inner.get(key);
  }

  has(key: K): boolean {
    return this.#inner.has(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    this.#inner.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[K, V]> {
    return this.#inner.entries();
  }

  keys(): MapIterator<K> {
    return this.#inner.keys();
  }

  values(): MapIterator<V> {
    return this.#inner.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#inner[Symbol.iterator]();
  }
}

export function asReadonlyMap<K, V>(map: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (map instanceof ReadonlyMapView) return map;
  const snapshot = new Map<K, V>();
  for (const [k, v] of map.entries()) snapshot.set(k, v);
  return Object.freeze(new ReadonlyMapView(snapshot));
}

export function freezeReadonlyArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

export type CompileBootstrap = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly entrySourceFile: ts.SourceFile;
  readonly mainFn: ts.FunctionDeclaration;
  readonly runtimeKind: "none" | "tokio";
  readonly mainIsAsync: boolean;
  readonly returnKind: MainReturnKind;
  readonly rustReturnType?: RustType;
  readonly userSourceFiles: readonly ts.SourceFile[];
};

export type UserModuleIndex = {
  readonly userFilesByName: ReadonlyMap<string, ts.SourceFile>;
  readonly moduleNameByFile: ReadonlyMap<string, string>;
};

export type FileLowered = {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
  readonly uses: readonly RustItem[];
  readonly classes: readonly { readonly pos: number; readonly decl: ts.ClassDeclaration }[];
  readonly functions: readonly { readonly pos: number; readonly decl: ts.FunctionDeclaration }[];
  readonly typeAliases: readonly { readonly pos: number; readonly decl: ts.TypeAliasDeclaration }[];
  readonly interfaces: readonly { readonly pos: number; readonly decl: ts.InterfaceDeclaration }[];
  readonly annotations: readonly {
    readonly pos: number;
    readonly node: ts.Statement;
    readonly target: string;
    readonly attrs: readonly string[];
  }[];
};

export type HirDecl =
  | { readonly kind: "class"; readonly pos: number; readonly decl: ts.ClassDeclaration }
  | { readonly kind: "function"; readonly pos: number; readonly decl: ts.FunctionDeclaration }
  | { readonly kind: "typeAlias"; readonly pos: number; readonly decl: ts.TypeAliasDeclaration }
  | { readonly kind: "interface"; readonly pos: number; readonly decl: ts.InterfaceDeclaration };

export type HirModule = {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
  readonly uses: readonly RustItem[];
  readonly declarations: readonly HirDecl[];
  readonly annotations: readonly {
    readonly pos: number;
    readonly node: ts.Statement;
    readonly target: string;
    readonly attrs: readonly string[];
  }[];
};

export type ShapeStructDefLike = {
  readonly key: string;
  readonly name: string;
  readonly span: Span;
  readonly vis: "pub" | "private";
  readonly fields: readonly { readonly name: string; readonly type: RustType }[];
};
