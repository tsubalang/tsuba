import { expect } from "chai";
import ts from "typescript";

import { unionKeyFromDecl } from "./common.js";
import {
  unionDefFromIdentifier,
  unionDefFromType,
  unionKeyFromType,
} from "./union-model.js";

describe("@tsuba/compiler lowering/union-model", () => {
  const source = [
    "type Shape = { kind: 'circle'; radius: i32 } | { kind: 'square'; side: i32 };",
    "function area(shape: Shape): i32 {",
    "  return 0 as i32;",
    "}",
    "",
  ].join("\n");

  function buildProgram(): {
    readonly sf: ts.SourceFile;
    readonly checker: ts.TypeChecker;
  } {
    const fileName = "shape.ts";
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      noLib: true,
    };
    const host = ts.createCompilerHost(options, true);
    host.getSourceFile = (fn, lang) => {
      if (fn === fileName) {
        return ts.createSourceFile(fileName, source, lang, true, ts.ScriptKind.TS);
      }
      return undefined;
    };
    host.readFile = (fn) => (fn === fileName ? source : undefined);
    host.fileExists = (fn) => fn === fileName;
    const program = ts.createProgram([fileName], options, host);
    const sf = program.getSourceFile(fileName);
    expect(sf).to.not.equal(undefined);
    return { sf: sf!, checker: program.getTypeChecker() };
  }

  it("derives alias keys from type aliases", () => {
    const { sf } = buildProgram();
    const aliasDecl = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s));
    expect(aliasDecl).to.not.equal(undefined);
    expect(unionKeyFromDecl(aliasDecl!)).to.equal("shape.ts::Shape");
  });

  it("maps TypeScript alias types back to union keys", () => {
    const { sf, checker } = buildProgram();
    const fnDecl = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s));
    expect(fnDecl).to.not.equal(undefined);
    const param = fnDecl!.parameters[0];
    expect(param).to.not.equal(undefined);
    const type = checker.getTypeAtLocation(param!.name);
    expect(unionKeyFromType(type)).to.equal("shape.ts::Shape");
  });

  it("resolves union models from type and identifier lookups", () => {
    const { sf, checker } = buildProgram();
    const aliasDecl = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s));
    expect(aliasDecl).to.not.equal(undefined);
    const key = unionKeyFromDecl(aliasDecl!);
    const shapeDef = { key, name: "Shape", discriminant: "kind", variants: [] };

    const fnDecl = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s));
    expect(fnDecl).to.not.equal(undefined);
    const param = fnDecl!.parameters[0];
    expect(param).to.not.equal(undefined);
    expect(ts.isIdentifier(param!.name)).to.equal(true);

    const ctx = {
      checker,
      unions: new Map([[key, shapeDef]]),
    };
    const byType = unionDefFromType(ctx, checker.getTypeAtLocation(param!.name));
    const byIdent = unionDefFromIdentifier(ctx, param!.name as ts.Identifier);
    expect(byType).to.equal(shapeDef);
    expect(byIdent).to.equal(shapeDef);
  });
});
