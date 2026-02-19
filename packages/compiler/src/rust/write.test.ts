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
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
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

  it("writes `use` and `mod` items with stable indentation", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        { kind: "use", path: { segments: ["crate", "math", "add"] } },
        {
          kind: "mod",
          name: "math",
          items: [
            { kind: "use", path: { segments: ["crate", "util", "f"] }, alias: "f" },
            {
              kind: "fn",
              vis: "pub",
              async: false,
              typeParams: [],
              receiver: { kind: "none" },
              name: "add",
              params: [{ name: "a", type: pathType(["i32"]) }],
              ret: pathType(["i32"]),
              attrs: [],
              body: [{ kind: "return", expr: identExpr("a") }],
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("use crate::math::add;");
    expect(rust).to.contain("mod math {");
    expect(rust).to.contain("  use crate::util::f as f;");
    expect(rust).to.contain("  pub fn add(a: i32) -> i32 {");
    expect(rust).to.contain("    return a;");
  });

  it("writes type aliases deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "type_alias",
          vis: "pub",
          name: "Pair",
          typeParams: [{ name: "T", bounds: [] }],
          attrs: ["#[allow(non_camel_case_types)]"],
          target: { kind: "tuple", elems: [pathType(["T"]), pathType(["T"])] },
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.equal(
      [
        "#[allow(non_camel_case_types)]",
        "pub type Pair<T> = (T, T);",
        "",
      ].join("\n")
    );
  });

  it("writes reference types (&T / &mut T / &'a T) deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "f",
          params: [
            { name: "x", type: { kind: "ref", mut: false, inner: pathType(["i32"]) } },
            { name: "y", type: { kind: "ref", mut: true, inner: pathType(["i32"]) } },
            { name: "z", type: { kind: "ref", mut: false, lifetime: "a", inner: pathType(["i32"]) } },
          ],
          ret: unitType(),
          attrs: [],
          body: [],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("fn f(x: &i32, y: &mut i32, z: &'a i32) {");
  });

  it("writes block expressions in a stable single-line form (v0)", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
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

  it("writes nested control-flow inside block expressions without placeholders", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
          body: [
            {
              kind: "let",
              pattern: { kind: "ident", name: "x" },
              mut: false,
              init: {
                kind: "block",
                stmts: [
                  {
                    kind: "if",
                    cond: { kind: "bool", value: true },
                    then: [{ kind: "expr", expr: unitExpr() }],
                    else: [{ kind: "expr", expr: unitExpr() }],
                  },
                  {
                    kind: "while",
                    cond: { kind: "bool", value: false },
                    body: [{ kind: "break" }],
                  },
                  {
                    kind: "match",
                    expr: identExpr("tag"),
                    arms: [{ pattern: { kind: "wild" }, body: [{ kind: "expr", expr: unitExpr() }] }],
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
    expect(rust).to.contain("if true {");
    expect(rust).to.contain("while false {");
    expect(rust).to.contain("match tag {");
    expect(rust).to.not.contain("__tsuba_unreachable_inline_");
  });

  it("writes borrow expressions (&x / &mut y) deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
          body: [
            {
              kind: "expr",
              expr: {
                kind: "call",
                callee: identExpr("f"),
                args: [
                  { kind: "borrow", mut: false, expr: identExpr("x") },
                  { kind: "borrow", mut: true, expr: identExpr("y") },
                ],
              },
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("f(&(x), &mut (y));");
  });

  it("writes closures (including move closures) deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
          body: [
            {
              kind: "let",
              pattern: { kind: "ident", name: "a" },
              mut: false,
              init: {
                kind: "closure",
                move: false,
                params: [{ name: "x", type: pathType(["i32"]) }],
                body: { kind: "binary", op: "+", left: identExpr("x"), right: { kind: "number", text: "1" } },
              },
            },
            {
              kind: "let",
              pattern: { kind: "ident", name: "b" },
              mut: false,
              init: {
                kind: "closure",
                move: true,
                params: [{ name: "x", type: pathType(["i32"]) }],
                body: { kind: "binary", op: "+", left: identExpr("x"), right: { kind: "number", text: "2" } },
              },
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("let a = |x: i32| (x + 1);");
    expect(rust).to.contain("let b = move |x: i32| (x + 2);");
  });

  it("writes turbofish path calls deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: false,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
          body: [
            {
              kind: "expr",
              expr: {
                kind: "path_call",
                path: { segments: ["foo", "bar"] },
                typeArgs: [pathType(["u32"]), pathType(["f32"])],
                args: [identExpr("x")],
              },
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("foo::bar::<u32, f32>(x);");
  });

  it("writes async fns and await expressions deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "fn",
          vis: "private",
          async: true,
          typeParams: [],
          receiver: { kind: "none" },
          name: "main",
          params: [],
          ret: unitType(),
          attrs: [],
          body: [
            {
              kind: "let",
              pattern: { kind: "ident", name: "x" },
              mut: false,
              init: {
                kind: "await",
                expr: { kind: "call", callee: identExpr("work"), args: [] },
              },
            },
          ],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("async fn main()");
    expect(rust).to.contain("let x = (work()).await;");
  });

  it("writes generic traits/impls and trait method signatures deterministically", () => {
    const program: RustProgram = {
      kind: "program",
      items: [
        {
          kind: "trait",
          vis: "pub",
          name: "BoxLike",
          typeParams: [{ name: "T", bounds: [] }],
          superTraits: [pathType(["Clone"])],
          items: [
            {
              kind: "fn",
              vis: "private",
              async: false,
              typeParams: [{ name: "U", bounds: [pathType(["Copy"])] }],
              receiver: { kind: "ref_self", mut: false },
              name: "get",
              params: [{ name: "seed", type: pathType(["U"]) }],
              ret: pathType(["T"]),
              attrs: [],
            },
          ],
        },
        {
          kind: "impl",
          typeParams: [{ name: "T", bounds: [] }],
          traitPath: pathType(["BoxLike"], [pathType(["T"])]),
          typePath: pathType(["Box"], [pathType(["T"])]),
          items: [],
        },
      ],
    };

    const rust = writeRustProgram(program);
    expect(rust).to.contain("pub trait BoxLike<T>: Clone {");
    expect(rust).to.contain("fn get<U: Copy>(&self, seed: U) -> T;");
    expect(rust).to.contain("impl<T> BoxLike<T> for Box<T> {");
  });
});
