import ts from "typescript";
import { basename } from "node:path";

export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function rustIdentFromStem(stem: string): string {
  const raw = stem
    .replaceAll(/[^A-Za-z0-9_]/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  const lower = raw.length === 0 ? "mod" : raw.toLowerCase();
  return /^[0-9]/.test(lower) ? `_${lower}` : lower;
}

export function rustModuleNameFromFileName(fileName: string): string {
  const b = basename(fileName);
  const stem = b.replaceAll(/\.[^.]+$/g, "");
  return rustIdentFromStem(stem);
}

export function rustTypeNameFromTag(tag: string): string {
  const raw = tag
    .replaceAll(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
  const withPrefix = raw.length > 0 ? raw : "Variant";
  return /^[0-9]/.test(withPrefix) ? `V${withPrefix}` : withPrefix;
}

export function splitRustPath(path: string): readonly string[] {
  return path.split("::").filter((s) => s.length > 0);
}

export function unionKeyFromDecl(decl: ts.TypeAliasDeclaration): string {
  return normalizePath(decl.getSourceFile().fileName) + "::" + decl.name.text;
}

export function traitKeyFromDecl(decl: ts.InterfaceDeclaration): string {
  return normalizePath(decl.getSourceFile().fileName) + "::" + decl.name.text;
}

export function expressionToSegments(expr: ts.Expression): readonly string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expressionToSegments(expr.expression);
    if (!left) return undefined;
    return [...left, expr.name.text];
  }
  return undefined;
}

export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function anonStructName(key: string): string {
  return `__Anon_${fnv1a32(key).toString(16).padStart(8, "0")}`;
}
