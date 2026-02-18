import { expect } from "chai";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "./init.js";

describe("@tsuba/cli init", () => {
  it("creates a workspace + a default project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-init-"));
    const projectDir = join(dir, "demo");
    // Make a stable project path under the temp root
    // (so project name is deterministic).
    await runInit({ dir: projectDir });

    const ws = JSON.parse(readFileSync(join(projectDir, "tsuba.workspace.json"), "utf-8")) as {
      readonly schema: number;
    };
    expect(ws.schema).to.equal(1);

    const proj = JSON.parse(
      readFileSync(join(projectDir, "packages", "demo", "tsuba.json"), "utf-8")
    ) as { readonly name: string };
    expect(proj.name).to.equal("demo");

    const entry = readFileSync(join(projectDir, "packages", "demo", "src", "main.ts"), "utf-8");
    expect(entry).to.contain("export function main()");
  });
});
