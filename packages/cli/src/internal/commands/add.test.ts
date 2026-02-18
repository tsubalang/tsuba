import { expect } from "chai";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAdd } from "./add.js";
import { runInit } from "./init.js";

describe("@tsuba/cli add", () => {
  function getRepoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const repoRoot = getRepoRoot();
    const base = join(repoRoot, ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  it("adds a crates.io dependency to tsuba.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-add-"));
    const ws = join(root, "demo");
    await runInit({ dir: ws });

    const projectRoot = join(ws, "packages", "demo");
    await runAdd({ dir: join(projectRoot, "src"), argv: ["crate", "serde@1.0.0"] });

    const json = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as any;
    expect(json.deps.crates).to.deep.equal([{ id: "serde", version: "1.0.0" }]);
  });

  it("adds a path dependency to tsuba.json", async () => {
    const ws = makeRepoTempDir("cli-add-path-");
    const projectName = basename(ws);
    await runInit({ dir: ws });

    const projectRoot = join(ws, "packages", projectName);
    await runAdd({ dir: projectRoot, argv: ["path", "localcrate", "../localcrate"] });

    const json = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as any;
    expect(json.deps.crates).to.deep.equal([{ id: "localcrate", path: "../localcrate" }]);
  });
});

