import type {
  ParsedModule,
  RustEnum,
  RustField,
  RustFunction,
  RustMethod,
  RustMethodKind,
  RustStruct,
  RustTrait,
} from "./common.js";
import { compareText, isSelfLike, normalizeIdentifier } from "./common.js";

function methodKey(method: {
  readonly kind: RustMethodKind;
  readonly name: string;
  readonly typeParams: readonly string[];
  readonly params: readonly RustField[];
  readonly returnType: string;
}): string {
  return [
    method.kind,
    method.name,
    method.typeParams.join(","),
    method.params.map((p) => `${p.name}:${p.type}`).join(","),
    method.returnType,
  ].join("|");
}

export function attachMethods(modules: ParsedModule[]): void {
  const structByName = new Map<string, RustStruct>();
  for (const m of modules) {
    for (const s of m.structs) structByName.set(s.name, s);
  }
  for (const m of modules) {
    for (const [targetRaw, methods] of m.pendingMethods) {
      const target = normalizeIdentifier(targetRaw);
      const struct = structByName.get(target);
      if (!struct) continue;
      for (const mth of methods) {
        const isInstance = mth.params.length > 0 && isSelfLike(mth.params[0]?.name ?? "");
        const params = isInstance
          ? mth.params.slice(1).filter((p) => p.type !== "void")
          : mth.params.filter((p) => p.type !== "void");
        if (mth.name === "new" || mth.name === "new_") {
          const nextCtor: RustMethod = {
            name: "new",
            kind: "constructor",
            typeParams: mth.typeParams,
            params,
            returnType: mth.returnType,
          };
          if (!struct.constructorMethod || methodKey(struct.constructorMethod) !== methodKey(nextCtor)) {
            struct.constructorMethod = nextCtor;
          }
          continue;
        }
        const nextMethod: RustMethod = {
          name: mth.name,
          kind: isInstance ? "instance" : "static",
          typeParams: mth.typeParams,
          params,
          returnType: mth.returnType,
        };
        if (struct.methods.some((existing) => methodKey(existing) === methodKey(nextMethod))) continue;
        struct.methods.push(nextMethod);
      }
    }
  }
}

function cloneAsConst(value: RustField, name: string): RustField {
  return { kind: "field", name, type: value.type };
}

function cloneAsEnum(value: RustEnum, name: string): RustEnum {
  return {
    name,
    typeParams: [...value.typeParams],
    variants: value.variants.map((v) => ({
      name: v.name,
      fields: v.fields.map((f) => ({ kind: "field", name: f.name, type: f.type })),
    })),
  };
}

function cloneAsStruct(value: RustStruct, name: string): RustStruct {
  return {
    name,
    typeParams: [...value.typeParams],
    fields: value.fields.map((f) => ({ kind: "field", name: f.name, type: f.type })),
    methods: value.methods.map((m) => ({
      name: m.name,
      kind: m.kind,
      typeParams: [...m.typeParams],
      params: m.params.map((p) => ({ kind: "field", name: p.name, type: p.type })),
      returnType: m.returnType,
    })),
    constructorMethod: value.constructorMethod
      ? {
          name: value.constructorMethod.name,
          kind: value.constructorMethod.kind,
          typeParams: [...value.constructorMethod.typeParams],
          params: value.constructorMethod.params.map((p) => ({ kind: "field", name: p.name, type: p.type })),
          returnType: value.constructorMethod.returnType,
        }
      : undefined,
  };
}

function cloneAsTrait(value: RustTrait, name: string): RustTrait {
  return {
    name,
    typeParams: [...value.typeParams],
    superTraits: [...value.superTraits],
    methods: value.methods.map((m) => ({
      name: m.name,
      typeParams: [...m.typeParams],
      params: m.params.map((p) => ({ kind: "field", name: p.name, type: p.type })),
      returnType: m.returnType,
    })),
  };
}

function cloneAsFunction(value: RustFunction, name: string): RustFunction {
  return {
    kind: value.kind,
    name,
    typeParams: [...value.typeParams],
    params: value.params.map((p) => ({ kind: "field", name: p.name, type: p.type })),
    returnType: value.returnType,
  };
}

function hasDeclarationNamed(module: ParsedModule, name: string): boolean {
  if (module.consts.some((d) => d.name === name)) return true;
  if (module.enums.some((d) => d.name === name)) return true;
  if (module.structs.some((d) => d.name === name)) return true;
  if (module.traits.some((d) => d.name === name)) return true;
  if (module.functions.some((d) => d.name === name)) return true;
  return false;
}

function findModuleByParts(modules: readonly ParsedModule[], parts: readonly string[]): ParsedModule | undefined {
  const key = parts.join("::");
  return modules.find((m) => m.moduleParts.join("::") === key);
}

function resolveReexportSourceModule(
  modules: readonly ParsedModule[],
  from: ParsedModule,
  sourcePath: readonly string[]
): { readonly module: ParsedModule; readonly symbol: string } | undefined {
  if (sourcePath.length === 0) return undefined;
  const [head, ...rest] = sourcePath;
  if (!head) return undefined;

  let baseParts: string[];
  let lookupParts: string[];

  if (head === "crate") {
    baseParts = [];
    lookupParts = rest;
  } else if (head === "self") {
    baseParts = [...from.moduleParts];
    lookupParts = rest;
  } else if (head === "super") {
    baseParts = from.moduleParts.length === 0 ? [] : from.moduleParts.slice(0, -1);
    lookupParts = rest;
  } else {
    baseParts = [...from.moduleParts];
    lookupParts = [...sourcePath];
  }

  if (lookupParts.length === 0) return undefined;
  const symbol = lookupParts[lookupParts.length - 1]!;
  const moduleParts = [...baseParts, ...lookupParts.slice(0, -1)];
  const module = findModuleByParts(modules, moduleParts);
  if (!module) return undefined;
  return { module, symbol };
}

function addReexportedDeclaration(
  toModule: ParsedModule,
  fromModule: ParsedModule,
  sourceSymbol: string,
  exportedName: string
): boolean {
  if (hasDeclarationNamed(toModule, exportedName)) return true;

  const constDecl = fromModule.consts.find((d) => d.name === sourceSymbol);
  if (constDecl) {
    toModule.consts.push(cloneAsConst(constDecl, exportedName));
    return true;
  }

  const enumDecl = fromModule.enums.find((d) => d.name === sourceSymbol);
  if (enumDecl) {
    toModule.enums.push(cloneAsEnum(enumDecl, exportedName));
    return true;
  }

  const structDecl = fromModule.structs.find((d) => d.name === sourceSymbol);
  if (structDecl) {
    toModule.structs.push(cloneAsStruct(structDecl, exportedName));
    return true;
  }

  const traitDecl = fromModule.traits.find((d) => d.name === sourceSymbol);
  if (traitDecl) {
    toModule.traits.push(cloneAsTrait(traitDecl, exportedName));
    return true;
  }

  const fnDecl = fromModule.functions.find((d) => d.name === sourceSymbol);
  if (fnDecl) {
    toModule.functions.push(cloneAsFunction(fnDecl, exportedName));
    return true;
  }

  return false;
}

function sortModuleDeclarations(module: ParsedModule): void {
  module.consts.sort((a, b) => compareText(a.name, b.name));
  module.enums.sort((a, b) => compareText(a.name, b.name));
  module.structs.sort((a, b) => compareText(a.name, b.name));
  module.traits.sort((a, b) => compareText(a.name, b.name));
  module.functions.sort((a, b) => {
    const byName = compareText(a.name, b.name);
    if (byName !== 0) return byName;
    return compareText(a.kind, b.kind);
  });
}

export function applyReexports(modules: ParsedModule[]): void {
  for (const module of modules) {
    for (const reexport of module.reexports) {
      const segments = reexport.source.split("::").filter((s) => s.length > 0);
      const resolved = resolveReexportSourceModule(modules, module, segments);
      if (!resolved) {
        module.issues.push({
          file: module.source,
          kind: "reexport",
          snippet: `${reexport.name} <- ${reexport.source}`,
          reason: "Could not resolve re-export source module path.",
        });
        continue;
      }
      const ok = addReexportedDeclaration(module, resolved.module, resolved.symbol, reexport.name);
      if (!ok) {
        module.issues.push({
          file: module.source,
          kind: "reexport",
          snippet: `${reexport.name} <- ${reexport.source}`,
          reason: "Could not resolve re-exported symbol in source module.",
        });
      }
    }
    sortModuleDeclarations(module);
  }
}
