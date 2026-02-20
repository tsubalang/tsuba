import type {
  ParsedModule,
  RustEnum,
  RustField,
  RustFunction,
  RustStruct,
  RustTrait,
  RustTraitMethod,
  RustType,
  SkipIssue,
} from "./common.js";
import {
  fail,
  findMatching,
  normalizeIdentifier,
  normalizeTypeText,
  skipWs,
  splitTopLevel,
} from "./common.js";

export function parseGenericParamNames(raw: string, file: string, issues: SkipIssue[]): string[] {
  const out: string[] = [];
  for (const entry0 of splitTopLevel(raw, ",")) {
    const entry = entry0.trim();
    if (entry.length === 0) continue;
    if (entry.startsWith("'")) {
      issues.push({
        file,
        kind: "generic",
        snippet: entry,
        reason: "Rust lifetime generic parameters are not representable in TS facades and were skipped.",
      });
      continue;
    }
    const noConst = entry.startsWith("const ") ? entry.slice("const ".length).trim() : entry;
    if (entry.startsWith("const ")) {
      issues.push({
        file,
        kind: "generic",
        snippet: entry,
        reason: "Rust const generic parameters are not representable in TS facades and were skipped.",
      });
    }
    const [lhs] = noConst.split(":");
    const [namePart] = (lhs ?? noConst).split("=");
    const name = normalizeIdentifier((namePart ?? "").trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      issues.push({
        file,
        kind: "generic",
        snippet: entry,
        reason: "Unsupported generic parameter syntax.",
      });
      continue;
    }
    out.push(name);
  }
  return out;
}

function stripCommentsAndAttrs(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*(?=[\n\r]|$)/g, "")
    .replace(/^\s*#\[[^\]\n]*\]\s*$/gm, "");
}

export function parseType(raw: string, file: string, issues: SkipIssue[]): RustType {
  const withoutRhs = raw.split("=").map((part) => part.trim())[0] ?? raw;
  const text = normalizeTypeText(withoutRhs);
  if (text === "()" || text.length === 0) return "void";
  const open = text.indexOf("<");
  const close = text.lastIndexOf(">");
  if (open >= 0 && close > open && close === text.length - 1) {
    const base = text.slice(0, open).trim();
    const generic = text.slice(open + 1, close);
    const args = splitTopLevel(generic, ",").filter((s) => s.length > 0);
    const mappedArgs = args.map((arg) => parseType(arg, file, issues));
    const baseText = parseType(base, file, issues);
    if (base === "Vec") return `${mappedArgs[0] ?? "void"}[]`;
    if (base === "Option") return `Option<${mappedArgs[0] ?? "void"}>`;
    if (base === "Result") return `Result<${mappedArgs[0] ?? "void"}, ${mappedArgs[1] ?? "void"}>`;
    if (base === "Slice") return `Slice<${mappedArgs[0] ?? "void"}>`;
    if (base === "ArrayN") return `ArrayN<${mappedArgs[0] ?? "void"}, ${mappedArgs[1] ?? "0"}>`;
    if (base.startsWith("mutref") || base.startsWith("ref")) {
      return `${baseText}<${mappedArgs.join(", ")}>`;
    }
    return `${normalizeIdentifier(baseText)}<${mappedArgs.join(", ")}>`;
  }

  if (/^&\s*'/.test(text)) {
    const m = /^&\s*'([A-Za-z_][A-Za-z0-9_]*)\s+mut\s+(.+)$/s.exec(text);
    if (m?.[1] && m[2]) return `mutrefLt<"${m[1]}", ${parseType(m[2], file, issues)}>`;
    const n = /^&\s*'([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/s.exec(text);
    if (n?.[1] && n[2]) return `refLt<"${n[1]}", ${parseType(n[2], file, issues)}>`;
  }
  if (text.startsWith("&mut ")) return `mutref<${parseType(text.slice(5), file, issues)}>`;
  if (text.startsWith("&")) return `ref<${parseType(text.slice(1), file, issues)}>`;
  if (text.startsWith("'")) return text;
  if (text === "Self") return "Self";
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1);
    const semi = inner.lastIndexOf(";");
    if (semi !== -1) {
      const item = inner.slice(0, semi).trim();
      const len = inner.slice(semi + 1).trim();
      if (len.length > 0) {
        if (/^[0-9]+$/u.test(len)) return `ArrayN<${parseType(item, file, issues)}, ${len}>`;
        issues.push({
          file,
          kind: "type",
          snippet: text,
          reason: "Array length uses a const expression/generic that is not representable in TS facades; using number.",
        });
        return `ArrayN<${parseType(item, file, issues)}, number>`;
      }
      return "void";
    }
  }
  if (text === "str") return "Str";
  if (text.includes("::")) {
    const parts = text.split("::").filter((s) => s.length > 0);
    return normalizeIdentifier(parts[parts.length - 1] ?? "void");
  }
  if (text.includes(" ")) {
    const compact = text.replace(/\s+/g, " ");
    if (compact.includes(" "))
      issues.push({
        file,
        kind: "type",
        snippet: text,
        reason: "Spaces in type expression could not be resolved safely; falling back to unknown.",
      });
    return "unknown";
  }
  return normalizeIdentifier(text);
}

function parseParams(raw: string, file: string, issues: SkipIssue[]): RustField[] {
  const body = normalizeTypeText(raw);
  if (!body) return [];
  const parts = splitTopLevel(body, ",");
  return parts.map((entry): RustField => {
    const segment = entry.trim();
    if (segment === "&self" || segment === "&mut self" || segment === "self") {
      return { kind: "field", name: segment, type: "self" };
    }
    const idx = segment.indexOf(":");
    if (idx === -1) {
      issues.push({
        file,
        kind: "param",
        snippet: segment,
        reason: "Non-standard function parameter syntax (expected name: type).",
      });
      return { kind: "field", name: "unsupported", type: "unknown" };
    }
    const name = segment.slice(0, idx).trim();
    const type = segment.slice(idx + 1).trim();
    return { kind: "field", name: normalizeIdentifier(name), type: parseType(type, file, issues) };
  });
}

function parseFunctions(text: string, file: string, issues: SkipIssue[]): RustFunction[] {
  const toplevel = (() => {
    const implRegex = /\bimpl(?:\s*<[^>]*>)?\s+[^{}]+\{/g;
    const ranges: Array<readonly [number, number]> = [];
    for (const match of text.matchAll(implRegex)) {
      const open = match.index + match[0].length - 1;
      const end = findMatching(text, open, "{", "}");
      if (end === -1) {
        issues.push({
          file,
          kind: "impl",
          snippet: String(match[1]),
          reason: "Could not parse impl block while stripping top-level functions.",
        });
        continue;
      }
      ranges.push([match.index, end + 1]);
    }
    if (ranges.length === 0) return text;
    ranges.sort((a, b) => b[0] - a[0]);
    let result = text;
    for (const [start, end] of ranges) {
      result = `${result.slice(0, start)}${result.slice(end)}`;
    }
    return result;
  })();

  const out: RustFunction[] = [];
  const fnRegex = /\bpub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of toplevel.matchAll(fnRegex)) {
    const name = match[1];
    if (!name) continue;
    const i = match.index + match[0].length;
    const trimmed = toplevel.slice(i).trimStart();
    const baseOffset = i + (toplevel.slice(i).length - trimmed.length);
    let p = baseOffset;
    let typeParams: string[] = [];
    if (toplevel[p] === "<") {
      const g = findMatching(toplevel, p, "<", ">");
      if (g === -1) continue;
      typeParams = parseGenericParamNames(toplevel.slice(p + 1, g), file, issues);
      p = g + 1;
    }
    p = skipWs(toplevel, p);
    if (toplevel[p] !== "(") continue;
    const paramsStart = p;
    const paramsEnd = findMatching(toplevel, paramsStart, "(", ")");
    if (paramsEnd === -1) continue;

    const paramsRaw = toplevel.slice(paramsStart + 1, paramsEnd);
    let q = paramsEnd + 1;
    q = skipWs(toplevel, q);
    let returnType = "void";
    let returnEnd = q;
    if (toplevel[q] === "-" && toplevel[q + 1] === ">") {
      q += 2;
      q = skipWs(toplevel, q);
      let r = q;
      for (; r < toplevel.length; r += 1) {
        if (toplevel[r] === "{") break;
      }
      returnType = normalizeTypeText(toplevel.slice(q, r));
      returnEnd = r;
    }
    const bodyStart = skipWs(toplevel, returnType === "void" ? q : returnEnd);
    if (toplevel[bodyStart] !== "{") continue;
    const bodyEnd = findMatching(toplevel, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    const fn: RustFunction = {
      kind: "fn",
      name: normalizeIdentifier(name),
      typeParams,
      params: parseParams(paramsRaw, file, issues),
      returnType: parseType(returnType, file, issues),
    };
    out.push(fn);
    void bodyEnd;
  }
  return out;
}

function parseStructs(text: string, file: string, issues: SkipIssue[]): RustStruct[] {
  const structs: RustStruct[] = [];
  const structRegex = /\bpub\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<([^>]*)>)?\s*\{/g;
  for (const match of text.matchAll(structRegex)) {
    const name = match[1];
    const genericRaw = match[2];
    if (!name) continue;
    const start = match.index + match[0].length - 1;
    const end = findMatching(text, start, "{", "}");
    if (end === -1) fail(`Unclosed struct body for ${name} in ${file}.`);
    const body = text.slice(start + 1, end);
    const fields: RustField[] = [];
    const fieldRegex = /\bpub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,\n;]+)[,;]?/g;
    for (const fm of body.matchAll(fieldRegex)) {
      const fieldName = fm[1];
      const fieldType = fm[2];
      if (!fieldName || !fieldType) continue;
      fields.push({
        kind: "field",
        name: normalizeIdentifier(fieldName),
        type: parseType(fieldType, file, issues),
      });
    }
    structs.push({
      name: normalizeIdentifier(name),
      typeParams: genericRaw ? parseGenericParamNames(genericRaw, file, issues) : [],
      fields,
      methods: [],
      constructorMethod: undefined,
    });
  }
  return structs;
}

function parseEnums(text: string, file: string, issues: SkipIssue[]): RustEnum[] {
  const enums: RustEnum[] = [];
  const enumRegex = /\bpub\s+enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<([^>]*)>)?\s*\{/g;
  for (const match of text.matchAll(enumRegex)) {
    const name = match[1];
    const genericRaw = match[2];
    if (!name) continue;
    const start = match.index + match[0].length - 1;
    const end = findMatching(text, start, "{", "}");
    if (end === -1) fail(`Unclosed enum body for ${name} in ${file}.`);
    const body = text.slice(start + 1, end);
    const variants = splitTopLevel(body, ",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const cleaned = entry.replace(/\s*=\s*.*$/g, "").trim();
        const openTuple = cleaned.indexOf("(");
        const openNamed = cleaned.indexOf("{");
        const firstDelim = (() => {
          if (openTuple === -1) return openNamed;
          if (openNamed === -1) return openTuple;
          return Math.min(openTuple, openNamed);
        })();

        if (firstDelim === -1) {
          return { name: normalizeIdentifier(cleaned), fields: [] as RustField[] };
        }

        const variantName = normalizeIdentifier(cleaned.slice(0, firstDelim).trim());
        if (cleaned[firstDelim] === "(") {
          const close = findMatching(cleaned, firstDelim, "(", ")");
          if (close === -1) {
            issues.push({
              file,
              kind: "enum",
              snippet: cleaned,
              reason: "Tuple enum variant payload could not be parsed.",
            });
            return { name: variantName, fields: [] as RustField[] };
          }
          const payload = cleaned.slice(firstDelim + 1, close);
          const fields = splitTopLevel(payload, ",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
            .map((value, index) => ({
              kind: "field" as const,
              name: `_${index}`,
              type: parseType(value, file, issues),
            }));
          return { name: variantName, fields };
        }

        const close = findMatching(cleaned, firstDelim, "{", "}");
        if (close === -1) {
          issues.push({
            file,
            kind: "enum",
            snippet: cleaned,
            reason: "Struct enum variant payload could not be parsed.",
          });
          return { name: variantName, fields: [] as RustField[] };
        }
        const payload = cleaned.slice(firstDelim + 1, close);
        const fields = splitTopLevel(payload, ",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => {
            const idx = value.indexOf(":");
            if (idx === -1) {
              issues.push({
                file,
                kind: "enum",
                snippet: value,
                reason: "Struct enum payload fields must be name: type.",
              });
              return { kind: "field" as const, name: "value", type: "unknown" };
            }
            const fieldName = normalizeIdentifier(value.slice(0, idx).trim());
            const fieldType = parseType(value.slice(idx + 1).trim(), file, issues);
            return { kind: "field" as const, name: fieldName, type: fieldType };
          });
        return { name: variantName, fields };
      });
    if (variants.length === 0) {
      issues.push({
        file,
        kind: "enum",
        snippet: name,
        reason: "Enum has no parseable variants.",
      });
    }
    enums.push({
      name: normalizeIdentifier(name),
      typeParams: genericRaw ? parseGenericParamNames(genericRaw, file, issues) : [],
      variants,
    });
  }
  return enums;
}

function parseTraitMethods(body: string, file: string, issues: SkipIssue[]): RustTraitMethod[] {
  const methods: RustTraitMethod[] = [];
  const fnRegex = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of body.matchAll(fnRegex)) {
    const rawName = match[1];
    if (!rawName) continue;
    const name = normalizeIdentifier(rawName);
    let p = match.index + match[0].length;
    p = skipWs(body, p);

    let methodTypeParams: string[] = [];
    if (body[p] === "<") {
      const genEnd = findMatching(body, p, "<", ">");
      if (genEnd === -1) {
        issues.push({
          file,
          kind: "trait-method",
          snippet: name,
          reason: "Could not parse trait method generic parameters.",
        });
        continue;
      }
      methodTypeParams = parseGenericParamNames(body.slice(p + 1, genEnd), file, issues);
      p = genEnd + 1;
      p = skipWs(body, p);
    }

    if (body[p] !== "(") {
      issues.push({
        file,
        kind: "trait-method",
        snippet: name,
        reason: "Trait method parameter list could not be parsed.",
      });
      continue;
    }
    const paramsStart = p;
    const paramsEnd = findMatching(body, paramsStart, "(", ")");
    if (paramsEnd === -1) {
      issues.push({
        file,
        kind: "trait-method",
        snippet: name,
        reason: "Unclosed trait method parameter list.",
      });
      continue;
    }
    const paramsRaw = body.slice(paramsStart + 1, paramsEnd);
    let q = skipWs(body, paramsEnd + 1);
    let returnType = "void";
    if (body[q] === "-" && body[q + 1] === ">") {
      q += 2;
      q = skipWs(body, q);
      let r = q;
      while (r < body.length && body[r] !== ";" && body[r] !== "{") r += 1;
      returnType = parseType(body.slice(q, r), file, issues);
      q = r;
    }
    if (body[q] === "{") {
      const endBody = findMatching(body, q, "{", "}");
      if (endBody === -1) {
        issues.push({
          file,
          kind: "trait-method",
          snippet: name,
          reason: "Unclosed trait method body.",
        });
      }
    }
    methods.push({
      name,
      typeParams: methodTypeParams,
      params: parseParams(paramsRaw, file, issues),
      returnType,
    });
  }
  return methods;
}

function parseTraits(text: string, file: string, issues: SkipIssue[]): RustTrait[] {
  const traits: RustTrait[] = [];
  const traitRegex = /\bpub\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of text.matchAll(traitRegex)) {
    const rawName = match[1];
    if (!rawName) continue;
    const name = normalizeIdentifier(rawName);
    let p = match.index + match[0].length;
    p = skipWs(text, p);

    let traitTypeParams: string[] = [];
    if (text[p] === "<") {
      const genEnd = findMatching(text, p, "<", ">");
      if (genEnd === -1) {
        issues.push({
          file,
          kind: "trait",
          snippet: name,
          reason: "Could not parse trait generic parameters.",
        });
        continue;
      }
      traitTypeParams = parseGenericParamNames(text.slice(p + 1, genEnd), file, issues);
      p = genEnd + 1;
      p = skipWs(text, p);
    }

    let superTraits: RustType[] = [];
    if (text[p] === ":") {
      p += 1;
      p = skipWs(text, p);
      let s = p;
      while (s < text.length && text[s] !== "{") s += 1;
      if (s >= text.length) {
        issues.push({
          file,
          kind: "trait",
          snippet: name,
          reason: "Unclosed trait header while reading supertraits.",
        });
        continue;
      }
      superTraits = splitTopLevel(text.slice(p, s), "+")
        .map((entry) => parseType(entry, file, issues))
        .filter((entry) => entry.length > 0 && entry !== "unknown");
      p = s;
    }

    if (text[p] !== "{") {
      issues.push({
        file,
        kind: "trait",
        snippet: name,
        reason: "Trait body could not be parsed.",
      });
      continue;
    }
    const bodyEnd = findMatching(text, p, "{", "}");
    if (bodyEnd === -1) {
      issues.push({
        file,
        kind: "trait",
        snippet: name,
        reason: "Unclosed trait body.",
      });
      continue;
    }
    const body = text.slice(p + 1, bodyEnd);
    const associatedTypes = [...body.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)]
      .map((m) => m[1])
      .filter((v): v is string => typeof v === "string")
      .map((v) => normalizeIdentifier(v));
    const assocSet = new Set<string>(associatedTypes);
    const typeParams = [...traitTypeParams, ...[...assocSet].filter((v) => !traitTypeParams.includes(v))];
    traits.push({
      name,
      typeParams,
      superTraits,
      methods: parseTraitMethods(body, file, issues),
    });
  }
  return traits;
}

function parseImpls(text: string, file: string, issues: SkipIssue[]): Map<string, RustFunction[]> {
  const methodsByTarget = new Map<string, RustFunction[]>();
  const implRegex = /\bimpl(?:\s*<[^>]*>)?\s+([^{}]+)\{/g;
  for (const match of text.matchAll(implRegex)) {
    const headerRaw = normalizeTypeText(match[1] ?? "");
    if (!headerRaw) continue;
    const targetExpr = (() => {
      if (headerRaw.includes(" for ")) {
        return headerRaw.split(/\s+for\s+/g).at(-1)?.trim() ?? "";
      }
      return headerRaw;
    })();
    const targetBase = targetExpr
      .split(/\s+where\s+/g)[0]
      ?.split("::")
      .at(-1)
      ?.replace(/<.*$/g, "")
      .trim();
    const target = targetBase ? normalizeIdentifier(targetBase) : "";
    if (!target) {
      issues.push({
        file,
        kind: "impl",
        snippet: headerRaw,
        reason: "Could not determine impl target type.",
      });
      continue;
    }
    const start = match.index + match[0].length - 1;
    const end = findMatching(text, start, "{", "}");
    if (end === -1) {
      issues.push({
        file,
        kind: "impl",
        snippet: String(headerRaw),
        reason: `Could not parse impl body for ${target}.`,
      });
      continue;
    }
    const body = text.slice(start + 1, end);
    const methods = parseFunctions(body, file, issues);
    if (methods.length > 0) methodsByTarget.set(target, methods);
  }
  return methodsByTarget;
}

export function parseModuleDeclarations(text: string, file: string): ParsedModule {
  const source = stripCommentsAndAttrs(text);
  const skip: SkipIssue[] = [];
  const module: ParsedModule = {
    specName: "",
    source: file,
    moduleParts: [],
    consts: [],
    enums: [],
    structs: [],
    traits: [],
    functions: [],
    reexports: [],
    pendingMethods: new Map(),
    issues: skip,
  };
  const constRegex = /\bpub\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^;]+);/g;
  for (const match of source.matchAll(constRegex)) {
    const name = match[1];
    const rawType = match[2];
    if (!name || !rawType) continue;
    module.consts.push({
      kind: "field",
      name: normalizeIdentifier(name),
      type: parseType(rawType, file, skip),
    });
  }
  module.functions = parseFunctions(source, file, skip);
  module.structs = parseStructs(source, file, skip);
  module.traits = parseTraits(source, file, skip);
  module.enums = parseEnums(source, file, skip);
  module.pendingMethods = parseImpls(source, file, skip);
  return module;
}

export function parseTraitMethodsForTest(body: string, file: string, issues: SkipIssue[]): RustTraitMethod[] {
  return parseTraitMethods(body, file, issues);
}
