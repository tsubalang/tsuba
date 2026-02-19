import { expect } from "chai";
import ts from "typescript";

import {
  anonStructName,
  compareText,
  expressionToSegments,
  normalizePath,
  rustModuleNameFromFileName,
  rustTypeNameFromTag,
  splitRustPath,
  traitKeyFromDecl,
  unionKeyFromDecl,
} from "./common.js";

describe("@tsuba/compiler lowering/common", () => {
  it("normalizes paths and comparison deterministically", () => {
    expect(normalizePath("a\\b\\c.ts")).to.equal("a/b/c.ts");
    expect(compareText("a", "a")).to.equal(0);
    expect(compareText("a", "b")).to.equal(-1);
    expect(compareText("b", "a")).to.equal(1);
  });

  it("builds deterministic module/type/anon names", () => {
    expect(rustModuleNameFromFileName("my-file.ts")).to.equal("my_file");
    expect(rustTypeNameFromTag("softmax-row")).to.equal("SoftmaxRow");
    expect(anonStructName("x.ts:10:20")).to.match(/^__Anon_[0-9a-f]{8}$/);
    expect(anonStructName("x.ts:10:20")).to.equal(anonStructName("x.ts:10:20"));
  });

  it("splits rust paths and expression segments deterministically", () => {
    expect(splitRustPath("a::b::c")).to.deep.equal(["a", "b", "c"]);
    const sf = ts.createSourceFile(
      "expr.ts",
      "const x = ns.deep.value;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const varStmt = sf.statements[0];
    if (!varStmt || !ts.isVariableStatement(varStmt)) {
      throw new Error("Expected a variable statement in test fixture.");
    }
    const init = varStmt.declarationList.declarations[0]?.initializer;
    expect(init).to.not.equal(undefined);
    expect(expressionToSegments(init as ts.Expression)).to.deep.equal(["ns", "deep", "value"]);
  });

  it("derives stable union/trait keys from declarations", () => {
    const sf = ts.createSourceFile(
      "models.ts",
      "type Shape = { kind: 'circle' } | { kind: 'square' }; interface Drawable { draw(this: ref<this>): void; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const unionDecl = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s));
    const traitDecl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s));
    expect(unionDecl).to.not.equal(undefined);
    expect(traitDecl).to.not.equal(undefined);
    expect(unionKeyFromDecl(unionDecl!)).to.equal("models.ts::Shape");
    expect(traitKeyFromDecl(traitDecl!)).to.equal("models.ts::Drawable");
  });
});
