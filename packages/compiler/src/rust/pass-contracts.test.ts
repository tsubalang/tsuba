import { expect } from "chai";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CompileError, compileHostToRust } from "./host.js";

describe("@tsuba/compiler pass contracts", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function readHostSource(): { readonly text: string; readonly sf: ts.SourceFile } {
    const hostPath = join(repoRoot(), "packages", "compiler", "src", "rust", "host.ts");
    const text = readFileSync(hostPath, "utf-8");
    const sf = ts.createSourceFile(hostPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return { text, sf };
  }

  function getFunctionBodyText(name: string): string {
    const { text, sf } = readHostSource();
    let found: ts.FunctionDeclaration | undefined;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
        found = st;
        break;
      }
    }
    expect(found, `Function '${name}' must exist in host.ts`).to.not.equal(undefined);
    expect(found?.body, `Function '${name}' must have a body`).to.not.equal(undefined);
    const body = found!.body!;
    return text.slice(body.pos, body.end);
  }

  it("keeps compileHostToRustImpl pass boundaries explicit", () => {
    const body = getFunctionBodyText("compileHostToRustImpl");
    expect(body).to.contain("const bootstrap = bootstrapCompileHost(opts);");
    expect(body).to.contain("const kernels = collectSortedKernelDecls(ctx, userSourceFiles);");
    expect(body).to.contain("createUserModuleIndex(userSourceFiles, entryFileName)");

    expect(body).to.not.contain("ts.createProgram(");
    expect(body).to.not.contain("ts.getPreEmitDiagnostics(");
    expect(body).to.not.contain("ts.createCompilerHost(");
  });

  it("uses readonly map wrappers for module-index pass outputs", () => {
    const body = getFunctionBodyText("createUserModuleIndex");
    expect(body).to.contain("userFilesByName: asReadonlyMap(userFilesByName)");
    expect(body).to.contain("moduleNameByFile: asReadonlyMap(moduleNameByFile)");
  });

  it("reports a synthetic span when the entry file is missing", () => {
    const missingEntry = join(tmpdir(), "tsuba-pass-contracts-missing", "main.ts");
    let err: unknown;
    try {
      compileHostToRust({ entryFile: missingEntry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CompileError);
    const ce = err as CompileError;
    expect(["TSB0001", "TSB0002"]).to.contain(ce.code);
    expect(ce.span).to.not.equal(undefined);
    expect(ce.span?.fileName).to.match(/main\.ts$/);
    expect(ce.span?.start).to.equal(0);
    expect(ce.span?.end).to.equal(0);
  });

  it("reports pre-emit TypeScript diagnostics with actionable spans", () => {
    const dir = makeRepoTempDir("compiler-pass-preemit-diag-");
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      [
        "export function main(): void {",
        '  const value: number = "not-a-number";',
        "  void value;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    let err: unknown;
    try {
      compileHostToRust({ entryFile: entry });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CompileError);
    const ce = err as CompileError;
    expect(ce.code).to.equal("TSB0002");
    expect(ce.message).to.contain("main.ts:");
    expect(ce.span).to.not.equal(undefined);
    expect(ce.span?.fileName).to.match(/main\.ts$/);
    expect(ce.span?.end).to.be.gte(ce.span?.start ?? 0);
  });
});
