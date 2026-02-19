import { expect } from "chai";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import {
  findNodeModulesPackageRoot,
  isMarkerModuleSpecifier,
  packageNameFromSpecifier,
  readBindingsManifest,
  resolveBindingsManifestPath,
} from "./bindings-manifest.js";

describe("@tsuba/compiler lowering/bindings-manifest", () => {
  const failAt = (_node: ts.Node, code: string, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };

  function specNode(): ts.Node {
    const sf = ts.createSourceFile("main.ts", 'import { x } from "@pkg/mod.js";', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const st = sf.statements[0];
    if (!st || !ts.isImportDeclaration(st)) {
      throw new Error("Expected import declaration in fixture source.");
    }
    return st.moduleSpecifier;
  }

  it("recognizes marker module specifiers and package names", () => {
    expect(isMarkerModuleSpecifier("@tsuba/core/lang.js")).to.equal(true);
    expect(isMarkerModuleSpecifier("@tsuba/other/lang.js")).to.equal(false);
    expect(packageNameFromSpecifier("@scope/name/path.js")).to.equal("@scope/name");
    expect(packageNameFromSpecifier("serde/json.js")).to.equal("serde");
    expect(packageNameFromSpecifier("serde")).to.equal("serde");
  });

  it("reads and normalizes a valid bindings manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-bindings-manifest-"));
    const manifestPath = join(dir, "tsuba.bindings.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema: 1,
          kind: "crate",
          crate: {
            name: "my_crate",
            package: "my-crate",
            path: "../crate-root",
            features: ["featA", "featB"],
          },
          modules: { "@scope/pkg/mod.js": "my_crate::mod" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    const parsed = readBindingsManifest(manifestPath, specNode(), { failAt });
    expect(parsed.schema).to.equal(1);
    expect(parsed.kind).to.equal("crate");
    expect(parsed.crate.name).to.equal("my_crate");
    expect(parsed.crate.package).to.equal("my-crate");
    expect(parsed.crate.path).to.equal(resolve(dirname(manifestPath), "../crate-root").replaceAll("\\", "/"));
    expect(parsed.crate.features).to.deep.equal(["featA", "featB"]);
    expect(parsed.modules["@scope/pkg/mod.js"]).to.equal("my_crate::mod");
  });

  it("fails with stable diagnostic codes for malformed manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-bindings-manifest-bad-"));
    const manifestPath = join(dir, "tsuba.bindings.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 2, kind: "crate", crate: { name: "x", version: "1.0.0" }, modules: {} }, null, 2),
      "utf-8"
    );

    let err: unknown;
    try {
      readBindingsManifest(manifestPath, specNode(), { failAt });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string } | undefined)?.code).to.equal("TSB3222");
  });

  it("resolves package root and bindings manifest from node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-bindings-resolve-"));
    const proj = join(root, "workspace", "packages", "app");
    mkdirSync(proj, { recursive: true });
    const pkgRoot = join(root, "workspace", "node_modules", "@scope", "pkg");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), '{"name":"@scope/pkg","version":"1.0.0"}\n', "utf-8");

    const found = findNodeModulesPackageRoot(join(proj, "src", "App.ts"), "@scope/pkg");
    expect(found).to.equal(pkgRoot);

    const manifest = resolveBindingsManifestPath("@scope/pkg/mod.js", join(proj, "src", "App.ts"));
    expect(manifest).to.equal(join(pkgRoot, "tsuba.bindings.json"));
    expect(resolveBindingsManifestPath("@tsuba/core/lang.js", join(proj, "src", "App.ts"))).to.equal(undefined);
    expect(resolveBindingsManifestPath("./local.ts", join(proj, "src", "App.ts"))).to.equal(undefined);
  });
});
