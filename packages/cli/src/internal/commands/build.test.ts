import { expect } from "chai";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBuild } from "./build.js";
import { runInit } from "./init.js";

describe("@tsuba/cli build", () => {
  it("generates a Rust crate for the current project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsuba-build-"));
    const root = join(dir, "demo");

    await runInit({ dir: root });
    const projectRoot = join(root, "packages", "demo");

    await runBuild({ dir: projectRoot });

    const mainRs = readFileSync(join(projectRoot, "generated", "src", "main.rs"), "utf-8");
    expect(mainRs).to.contain("fn main()");
  });
});

