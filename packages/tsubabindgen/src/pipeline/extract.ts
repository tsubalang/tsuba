import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtractedModule,
  ExtractedOutput,
  ParsedModule,
  RustFunction,
  SkipIssue,
} from "./common.js";
import {
  compareText,
  fail,
  normalizeIdentifier,
  normalizeTypeText,
} from "./common.js";
import { parseModuleDeclarations, parseType } from "./extract-parsers.js";

function collectModuleSourceFiles(filePath: string): readonly string[] {
  const srcDir = dirname(filePath);
  const text = readFileSync(filePath, "utf-8");
  const out: string[] = [];
  const modRegex = /\bpub\s+mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const match of text.matchAll(modRegex)) {
    const raw = match[1];
    if (!raw) continue;
    const direct = join(srcDir, `${raw}.rs`);
    const nested = join(srcDir, raw, "mod.rs");
    if (existsSync(direct)) out.push(direct);
    else if (existsSync(nested)) out.push(nested);
    else fail(`Could not resolve pub mod ${JSON.stringify(raw)} from ${filePath}.`);
  }
  return out;
}

function collectModulesLegacy(manifestPath: string): ParsedModule[] {
  const srcRoot = join(dirname(manifestPath), "src");
  const root = join(srcRoot, "lib.rs");
  if (!existsSync(root)) fail(`Missing library root ${root}.`);
  const out: ParsedModule[] = [];
  const seen = new Set<string>();

  const visit = (filePath: string, parts: readonly string[]): void => {
    const abs = resolve(filePath);
    if (seen.has(abs)) return;
    const source = readFileSync(abs, "utf-8");
    const module = parseModuleDeclarations(source, abs);
    module.moduleParts = [...parts];
    out.push(module);
    seen.add(abs);
    for (const child of collectModuleSourceFiles(abs)) {
      const file = basename(child);
      const modName = file === "mod.rs" ? basename(dirname(child)) : file.replace(/\.rs$/g, "");
      visit(child, [...parts, modName]);
    }
  };

  visit(root, []);
  out.sort((a, b) => {
    const left = a.moduleParts.join("::");
    const right = b.moduleParts.join("::");
    const byParts = compareText(left, right);
    if (byParts !== 0) return byParts;
    return compareText(a.source, b.source);
  });
  return out;
}

function mapExtractedFunction(fn: RustFunction, file: string, issues: SkipIssue[]): RustFunction {
  return {
    kind: fn.kind ?? "fn",
    name: normalizeIdentifier(fn.name),
    typeParams: [...(fn.typeParams ?? [])].map((p) => normalizeIdentifier(p)),
    params: fn.params.map((p) => ({
      kind: "field",
      name: normalizeIdentifier(p.name),
      type: parseType(p.type, file, issues),
    })),
    returnType: parseType(fn.returnType, file, issues),
  };
}

function mapExtractedModule(module: ExtractedModule): ParsedModule {
  const issues: SkipIssue[] = [...module.issues];
  const source = module.file;
  const structs = module.structs.map((s) => ({
    name: normalizeIdentifier(s.name),
    typeParams: [...(s.typeParams ?? [])].map((p) => normalizeIdentifier(p)),
    fields: s.fields.map((f) => ({
      kind: "field" as const,
      name: normalizeIdentifier(f.name),
      type: parseType(f.type, source, issues),
    })),
    methods: [],
    constructorMethod: undefined,
  }));
  const parsed: ParsedModule = {
    specName: "",
    source,
    moduleParts: [...module.parts],
    consts: module.consts.map((c) => ({
      kind: "field",
      name: normalizeIdentifier(c.name),
      type: parseType(c.type, source, issues),
    })),
    enums: module.enums.map((e) => ({
      name: normalizeIdentifier(e.name),
      typeParams: [...(e.typeParams ?? [])].map((p) => normalizeIdentifier(p)),
      variants: e.variants.map((v) => ({
        name: normalizeIdentifier(v.name),
        fields: (v.fields ?? []).map((f) => ({
          kind: "field",
          name: normalizeIdentifier(f.name),
          type: parseType(f.type, source, issues),
        })),
      })),
    })),
    structs,
    traits: module.traits.map((t) => ({
      name: normalizeIdentifier(t.name),
      typeParams: [...(t.typeParams ?? [])].map((p) => normalizeIdentifier(p)),
      superTraits: t.superTraits.map((st) => parseType(st, source, issues)),
      methods: t.methods.map((m) => ({
        name: normalizeIdentifier(m.name),
        typeParams: [...(m.typeParams ?? [])].map((p) => normalizeIdentifier(p)),
        params: m.params.map((p) => ({
          kind: "field",
          name: normalizeIdentifier(p.name),
          type: parseType(p.type, source, issues),
        })),
        returnType: parseType(m.returnType, source, issues),
      })),
    })),
    functions: module.functions.map((f) => mapExtractedFunction(f, source, issues)),
    reexports: [...(module.reexports ?? [])]
      .map((r) => ({ name: normalizeIdentifier(r.name), source: normalizeTypeText(r.source) }))
      .sort((a, b) => {
        const byName = compareText(a.name, b.name);
        if (byName !== 0) return byName;
        return compareText(a.source, b.source);
      }),
    pendingMethods: new Map<string, RustFunction[]>(),
    issues,
  };
  for (const entry of module.pendingMethods) {
    const target = normalizeIdentifier(entry.target);
    const mapped = entry.methods.map((m) => mapExtractedFunction(m, source, issues));
    const existing = parsed.pendingMethods.get(target) ?? [];
    parsed.pendingMethods.set(target, [...existing, ...mapped]);
  }
  return parsed;
}

function runRustExtractor(manifestPath: string): ExtractedOutput {
  const extractorManifest = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../rust-extractor/Cargo.toml"
  );
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "--manifest-path", extractorManifest, "--", manifestPath],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    fail(
      `tsubabindgen Rust extractor failed for ${manifestPath}:\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim()}`
    );
  }
  const raw = result.stdout?.trim();
  if (!raw) fail(`tsubabindgen Rust extractor returned no output for ${manifestPath}.`);
  const parsed = JSON.parse(raw) as ExtractedOutput;
  if (parsed.schema !== 1) {
    fail(`Unsupported extractor schema ${String((parsed as { schema?: unknown }).schema)} (expected 1).`);
  }
  return parsed;
}

export function collectModules(manifestPath: string): ParsedModule[] {
  const extracted = runRustExtractor(manifestPath);
  const modules = extracted.modules.map((m) => mapExtractedModule(m));
  modules.sort((a, b) => {
    const left = a.moduleParts.join("::");
    const right = b.moduleParts.join("::");
    const byParts = compareText(left, right);
    if (byParts !== 0) return byParts;
    return compareText(a.source, b.source);
  });
  if (modules.length > 0) {
    return modules;
  }
  if (process.env.TSUBABINDGEN_ALLOW_LEGACY === "1") {
    return collectModulesLegacy(manifestPath);
  }
  fail(
    `Rust extractor returned no modules for ${manifestPath}. Set TSUBABINDGEN_ALLOW_LEGACY=1 to debug with the legacy parser.`
  );
}
