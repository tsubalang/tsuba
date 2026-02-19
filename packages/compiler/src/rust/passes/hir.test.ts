import { expect } from "chai";
import ts from "typescript";

import type { FileLowered } from "./contracts.js";
import { buildHirModulesPass } from "./hir.js";

describe("@tsuba/compiler HIR pass", () => {
  function sourceFile(text: string): ts.SourceFile {
    return ts.createSourceFile("main.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  }

  it("normalizes declaration order and preserves immutable module snapshots", () => {
    const sf = sourceFile(
      [
        "export class C {}",
        "export function f(): void {}",
        "export type T = { x: number };",
        "export interface I {}",
        "",
      ].join("\n")
    );

    const cls = sf.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s))!;
    const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s))!;
    const ta = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s))!;
    const iface = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s))!;

    const lowered: FileLowered = Object.freeze({
      fileName: "main.ts",
      sourceFile: sf,
      uses: Object.freeze([]),
      // intentionally scrambled positions to verify deterministic sort in HIR
      classes: Object.freeze([Object.freeze({ pos: 40, decl: cls })]),
      functions: Object.freeze([Object.freeze({ pos: 30, decl: fn })]),
      typeAliases: Object.freeze([Object.freeze({ pos: 10, decl: ta })]),
      interfaces: Object.freeze([Object.freeze({ pos: 20, decl: iface })]),
      annotations: Object.freeze([]),
    });

    const hirByFile = buildHirModulesPass(new Map([["main.ts", lowered]]));
    const module = hirByFile.get("main.ts");
    expect(module).to.not.equal(undefined);
    const kinds = module!.declarations.map((d) => d.kind);
    expect(kinds).to.deep.equal(["typeAlias", "interface", "function", "class"]);
  });
});
