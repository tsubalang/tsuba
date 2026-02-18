import { expect } from "chai";

import { Err, HashMap, None, Ok, Some, Vec, panic } from "./prelude.js";

describe("@tsuba/std prelude", () => {
  it("constructs Option and Result values", () => {
    expect(Some(1)).to.deep.equal({ some: true, value: 1 });
    expect(None).to.deep.equal({ some: false });

    expect(Ok("x")).to.deep.equal({ ok: true, value: "x" });
    expect(Err("e")).to.deep.equal({ ok: false, error: "e" });
  });

  it("provides minimal Vec and HashMap behavior (runtime-only)", () => {
    const v = Vec.new<number>();
    v.push(10);
    v.push(20);
    expect(v.len()).to.equal(2);
    expect(v.get(0)).to.deep.equal({ some: true, value: 10 });
    expect(v.get(9)).to.deep.equal({ some: false });

    const m = HashMap.new<string, number>();
    expect(m.containsKey("a")).to.equal(false);
    expect(m.insert("a", 1)).to.deep.equal({ some: false });
    expect(m.containsKey("a")).to.equal(true);
    expect(m.get("a")).to.deep.equal({ some: true, value: 1 });
    expect(m.insert("a", 2)).to.deep.equal({ some: true, value: 1 });
  });

  it("panic throws", () => {
    expect(() => panic("boom")).to.throw(/boom/);
  });
});

