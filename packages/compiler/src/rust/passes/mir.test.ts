import { expect } from "chai";

import type { RustStmt } from "../ir.js";
import { emitMirBodyToRustStmtsPass, lowerRustBodyToMirPass } from "./mir.js";

describe("@tsuba/compiler MIR pass", () => {
  it("builds deterministic blocks and roundtrips structured control-flow", () => {
    const body: readonly RustStmt[] = [
      {
        kind: "let",
        pattern: { kind: "ident", name: "x" },
        mut: false,
        init: { kind: "number", text: "1" },
      },
      {
        kind: "if",
        cond: { kind: "bool", value: true },
        then: [{ kind: "expr", expr: { kind: "ident", name: "x" } }],
        else: [{ kind: "expr", expr: { kind: "number", text: "0" } }],
      },
      { kind: "expr", expr: { kind: "ident", name: "x" } },
      { kind: "return", expr: { kind: "ident", name: "x" } },
    ];

    const mir = lowerRustBodyToMirPass(body);
    expect(mir.entry).to.equal(0);
    expect(mir.blocks.length).to.be.greaterThan(0);
    expect(mir.blocks[0]?.id).to.equal(0);

    const roundtrip = emitMirBodyToRustStmtsPass(mir);
    expect(roundtrip).to.deep.equal(body);

    const mir2 = lowerRustBodyToMirPass(body);
    expect(mir2).to.deep.equal(mir);
  });

  it("omits trailing empty fallthrough block", () => {
    const body: readonly RustStmt[] = [
      {
        kind: "while",
        cond: { kind: "bool", value: true },
        body: [{ kind: "break" }],
      },
    ];

    const mir = lowerRustBodyToMirPass(body);
    expect(mir.blocks.length).to.equal(1);
    expect(mir.blocks[0]?.terminator.kind).to.equal("while");
    const roundtrip = emitMirBodyToRustStmtsPass(mir);
    expect(roundtrip).to.deep.equal(body);
  });
});
