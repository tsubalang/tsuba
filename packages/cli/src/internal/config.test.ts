import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findProjectRoot,
  findWorkspaceRoot,
  loadProjectConfig,
  loadProjectContext,
  loadWorkspaceConfig,
} from "./config.js";
import { runInit } from "./commands/init.js";

describe("@tsuba/cli config", () => {
  it("findWorkspaceRoot picks the nearest workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-workspace-"));
    const top = join(root, "top");
    const nested = join(top, "nested");
    const deep = join(nested, "packages", "demo", "docs");
    mkdirSync(deep, { recursive: true });

    writeFileSync(join(top, "tsuba.workspace.json"), "{}\n", "utf-8");
    writeFileSync(join(nested, "tsuba.workspace.json"), "{}\n", "utf-8");

    expect(findWorkspaceRoot(deep)).to.equal(nested);
  });

  it("findProjectRoot picks the nearest project root", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-project-"));
    const topProject = join(root, "tsuba.json");
    const nestedProjectRoot = join(root, "packages", "demo");
    const nestedProject = join(nestedProjectRoot, "tsuba.json");
    const deep = join(nestedProjectRoot, "src", "docs");
    mkdirSync(deep, { recursive: true });
    writeFileSync(topProject, "{}\n", "utf-8");
    writeFileSync(nestedProject, "{}\n", "utf-8");

    expect(findProjectRoot(deep)).to.equal(nestedProjectRoot);
  });

  it("loads a strict workspace config and rejects unknown keys", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-ws-strict-"));
    const wsPath = join(root, "tsuba.workspace.json");
    writeFileSync(
      wsPath,
      JSON.stringify(
        {
          schema: 1,
          rustEdition: "2021",
          packagesDir: "packages",
          generatedDirName: "generated",
          cargoTargetDir: ".tsuba/target",
          gpu: { backend: "none" },
          runtime: { kind: "none" },
          extra: true,
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    expect(() => loadWorkspaceConfig(wsPath)).to.throw("unknown key 'extra'");
  });

  it("requires gpu.cuda when backend is cuda", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-ws-cuda-"));
    const wsPath = join(root, "tsuba.workspace.json");
    writeFileSync(
      wsPath,
      JSON.stringify(
        {
          schema: 1,
          rustEdition: "2021",
          packagesDir: "packages",
          generatedDirName: "generated",
          cargoTargetDir: ".tsuba/target",
          gpu: { backend: "cuda" },
          runtime: { kind: "none" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    expect(() => loadWorkspaceConfig(wsPath)).to.throw("gpu.cuda");
  });

  it("loads a strict project config and validates crate deps", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-project-strict-"));
    const projectPath = join(root, "tsuba.json");
    writeFileSync(
      projectPath,
      JSON.stringify(
        {
          schema: 1,
          name: "demo",
          kind: "bin",
          entry: "src/main.ts",
          gpu: { enabled: false },
          crate: { name: "demo" },
          deps: { crates: [{ id: "serde", version: "1.0.0", path: "../serde" }] },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );

    expect(() => loadProjectConfig(projectPath)).to.throw("exactly one of 'version' or 'path'");
  });

  it("resolves project and workspace context from nested directories", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "tsuba-config-context-")), "demo");
    await runInit({ dir: root });
    const nested = join(root, "packages", "demo", "docs", "api");
    mkdirSync(nested, { recursive: true });

    const ctx = loadProjectContext(nested);
    expect(ctx.workspaceRoot).to.equal(root);
    expect(ctx.projectRoot).to.equal(join(root, "packages", "demo"));
    expect(ctx.workspace.schema).to.equal(1);
    expect(ctx.project.schema).to.equal(1);
  });

  it("allows project roots that are the same directory as workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-config-root-project-"));
    writeFileSync(
      join(root, "tsuba.workspace.json"),
      JSON.stringify(
        {
          schema: 1,
          rustEdition: "2021",
          packagesDir: "packages",
          generatedDirName: "generated",
          cargoTargetDir: ".tsuba/target",
          gpu: { backend: "none" },
          runtime: { kind: "none" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    writeFileSync(
      join(root, "tsuba.json"),
      JSON.stringify(
        {
          schema: 1,
          name: "rootproj",
          kind: "bin",
          entry: "src/main.ts",
          gpu: { enabled: false },
          crate: { name: "rootproj" },
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.ts"), "export function main(): void {}\n", "utf-8");

    const ctx = loadProjectContext(root);
    expect(ctx.workspaceRoot).to.equal(root);
    expect(ctx.projectRoot).to.equal(root);
    expect(ctx.project.name).to.equal("rootproj");
  });
});
