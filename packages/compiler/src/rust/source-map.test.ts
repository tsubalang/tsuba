import { expect } from "chai";

import { buildRustSourceMap, mapRustLineToTs } from "./source-map.js";

describe("@tsuba/compiler rust source map", () => {
  it("extracts stable mappings from tsuba-span comments", () => {
    const mainRs = [
      "fn main() {",
      "  // tsuba-span: src/main.ts:10:14",
      "  let x = 1;",
      "  // tsuba-span: src/main.ts:20:30",
      "  return;",
      "}",
      "",
    ].join("\n");

    const map = buildRustSourceMap(mainRs);
    expect(map.schema).to.equal(1);
    expect(map.kind).to.equal("rust-source-map");
    expect(map.entries.length).to.equal(2);
    expect(map.entries[0]).to.deep.equal({
      rustLine: 2,
      rustColumn: 1,
      tsFileName: "src/main.ts",
      tsStart: 10,
      tsEnd: 14,
    });
    expect(map.entries[1]).to.deep.equal({
      rustLine: 4,
      rustColumn: 1,
      tsFileName: "src/main.ts",
      tsStart: 20,
      tsEnd: 30,
    });
  });

  it("maps rust lines to nearest prior TS span deterministically", () => {
    const map = buildRustSourceMap(
      [
        "fn main() {",
        "  // tsuba-span: src/main.ts:5:8",
        "  let x = 1;",
        "  // tsuba-span: src/main.ts:20:25",
        "  let y = 2;",
        "}",
        "",
      ].join("\n")
    );

    expect(mapRustLineToTs(map, 1)).to.equal(undefined);
    expect(mapRustLineToTs(map, 2)).to.deep.equal({ fileName: "src/main.ts", start: 5, end: 8 });
    expect(mapRustLineToTs(map, 3)).to.deep.equal({ fileName: "src/main.ts", start: 5, end: 8 });
    expect(mapRustLineToTs(map, 5)).to.deep.equal({ fileName: "src/main.ts", start: 20, end: 25 });
  });
});
