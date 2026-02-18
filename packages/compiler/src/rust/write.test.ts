import { expect } from "chai";

import type { RustProgram } from "./ir.js";
import { identExpr, pathType, unitExpr, unitType } from "./ir.js";
import { writeRustProgram } from "./write.js";

describe("@tsuba/compiler rust writer", () => {
  it("writes basic items deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          name: "main",
          params: [],
          ret: unitType(),
          body: [
            {
              kind: "let",
              pattern: { kind: "ident", name: "x" },
              mut: false,
              type: pathType(["i32"]),
              init: {
                kind: "cast",
                expr: { kind: "number", text: "1" },
                type: pathType(["i32"]),
              },
            },
            {
              kind: "let",
              pattern: { kind: "ident", name: "y" },
              mut: true,
              type: pathType(["i32"]),
              init: identExpr("x"),
            },
            { kind: "return" },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program, { header: ["// hdr"] });
    expect(rust).to.equal(
      [
        "// hdr",
        "",
        "fn main() {",
        "  let x: i32 = (1) as i32;",
        "  let mut y: i32 = x;",
        "  return;",
        "}",
        "",
      ].join("\n")
    );
  });

  it("writes block expressions in a stable single-line form (v0)", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          name: "main",
          params: [],
          ret: unitType(),
          body: [
            {
              kind: "let",
              pattern: { kind: "ident", name: "x" },
              mut: false,
              init: {
                kind: "block",
                stmts: [
                  {
                    kind: "let",
                    pattern: { kind: "wild" },
                    mut: false,
                    init: { kind: "call", callee: identExpr("f"), args: [] },
                  },
                ],
                tail: unitExpr(),
              },
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("let x = { let _ = f(); () };");
  });
});

