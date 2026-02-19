import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "chai";

describe("@tsuba/tsubabindgen architecture", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "../../../");
  }

  it("keeps generate.ts focused on orchestration only", () => {
    const source = readFileSync(join(repoRoot(), "packages", "tsubabindgen", "src", "generate.ts"), "utf-8");
    expect(source).to.contain('from "./pipeline/extract.js";');
    expect(source).to.contain('from "./pipeline/resolve.js";');
    expect(source).to.contain('from "./pipeline/emit.js";');
    expect(source).to.not.contain("function parseFunctions(");
    expect(source).to.not.contain("function parseStructs(");
    expect(source).to.not.contain("function parseTraits(");
    expect(source).to.not.contain("function parseImpls(");
    expect(source).to.not.contain("function emitDts(");
    expect(source).to.not.contain("function collectStableSymbols(");
  });

  it("keeps parser/resolver/emitter stages physically separated", () => {
    const extractSource = readFileSync(
      join(repoRoot(), "packages", "tsubabindgen", "src", "pipeline", "extract.ts"),
      "utf-8"
    );
    const resolveSource = readFileSync(
      join(repoRoot(), "packages", "tsubabindgen", "src", "pipeline", "resolve.ts"),
      "utf-8"
    );
    const emitSource = readFileSync(
      join(repoRoot(), "packages", "tsubabindgen", "src", "pipeline", "emit.ts"),
      "utf-8"
    );

    expect(extractSource).to.contain("export function collectModules(");
    expect(extractSource).to.contain("function parseFunctions(");
    expect(extractSource).to.contain("function parseStructs(");
    expect(extractSource).to.contain("function parseTraits(");

    expect(resolveSource).to.contain("export function attachMethods(");
    expect(resolveSource).to.contain("export function applyReexports(");
    expect(resolveSource).to.not.contain("function parseFunctions(");

    expect(emitSource).to.contain("export function emitDts(");
    expect(emitSource).to.contain("export function collectStableSymbols(");
    expect(emitSource).to.contain("export function collectSkipIssues(");
    expect(emitSource).to.not.contain("function parseFunctions(");
  });
});
