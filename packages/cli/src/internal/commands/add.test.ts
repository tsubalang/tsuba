import { expect } from "chai";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    await runAdd(
      { dir: join(projectRoot, "src"), argv: ["crate", "serde@1.0.0"] },
      {
        spawnSync: (command, args, _opts) => {
          if (command === "cargo") {
            // Minimal cargo metadata stub for serde@1.0.0
            return {
              status: 0,
              stdout: JSON.stringify({
                packages: [
                  {
                    name: "serde",
                    version: "1.0.0",
                    manifest_path: "/cargo/registry/serde-1.0.0/Cargo.toml",
                    targets: [{ name: "serde", kind: ["lib"] }],
                  },
                ],
              }),
              stderr: "",
            } as any;
          }

          if (command === "tsubabindgen") {
            const outIdx = args.indexOf("--out");
            const outDir = outIdx === -1 ? undefined : String(args[outIdx + 1]);
            if (!outDir) throw new Error("test stub: expected --out");
            mkdirSync(outDir, { recursive: true });
            writeFileSync(
              join(outDir, "package.json"),
              JSON.stringify({ name: "@tsuba/serde", version: "0.0.0" }) + "\n",
              "utf-8"
            );
            writeFileSync(
              join(outDir, "tsuba.bindings.json"),
              JSON.stringify(
                {
                  schema: 1,
                  kind: "crate",
                  crate: { name: "serde", version: "1.0.0" },
                  modules: { "@tsuba/serde/index.js": "serde" },
                },
                null,
                2
              ) + "\n",
              "utf-8"
            );
            return { status: 0 } as any;
          }

          throw new Error(`test stub: unexpected command ${command}`);
        },
      }
    );

    const json = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as any;
    expect(json.deps.crates).to.deep.equal([{ id: "serde", version: "1.0.0" }]);
  });

  it("adds a path dependency to tsuba.json", async () => {
    const ws = makeRepoTempDir("cli-add-path-");
    const projectName = basename(ws);
    await runInit({ dir: ws });

    const projectRoot = join(ws, "packages", projectName);
    const localCrateRoot = join(projectRoot, "..", "localcrate");
    mkdirSync(localCrateRoot, { recursive: true });
    writeFileSync(join(localCrateRoot, "Cargo.toml"), "[package]\nname = \"localcrate\"\nversion = \"0.0.0\"\n", "utf-8");

    await runAdd(
      { dir: projectRoot, argv: ["path", "localcrate", "../localcrate"] },
      {
        spawnSync: (command, args, _opts) => {
          if (command === "cargo") {
            return {
              status: 0,
              stdout: JSON.stringify({
                packages: [
                  {
                    name: "localcrate",
                    version: "0.0.0",
                    manifest_path: join(localCrateRoot, "Cargo.toml"),
                    targets: [{ name: "localcrate", kind: ["lib"] }],
                  },
                ],
              }),
              stderr: "",
            } as any;
          }
          if (command === "tsubabindgen") {
            const outIdx = args.indexOf("--out");
            const outDir = outIdx === -1 ? undefined : String(args[outIdx + 1]);
            if (!outDir) throw new Error("test stub: expected --out");
            mkdirSync(outDir, { recursive: true });
            writeFileSync(
              join(outDir, "package.json"),
              JSON.stringify({ name: "@tsuba/localcrate", version: "0.0.0" }) + "\n",
              "utf-8"
            );
            writeFileSync(
              join(outDir, "tsuba.bindings.json"),
              JSON.stringify(
                {
                  schema: 1,
                  kind: "crate",
                  crate: { name: "localcrate", package: "localcrate", path: "./crate" },
                  modules: { "@tsuba/localcrate/index.js": "localcrate" },
                },
                null,
                2
              ) + "\n",
              "utf-8"
            );
            return { status: 0 } as any;
          }
          throw new Error(`test stub: unexpected command ${command}`);
        },
      }
    );

    const json = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as any;
    expect(json.deps.crates).to.deep.equal([
      { id: "localcrate", path: "../../node_modules/@tsuba/localcrate/crate" },
    ]);
  });

  it("records cargo package renames for hyphenated crates (simple-crate -> simple_crate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsuba-add-hyphen-"));
    const ws = join(root, "demo");
    await runInit({ dir: ws });

    const projectRoot = join(ws, "packages", "demo");
    await runAdd(
      { dir: projectRoot, argv: ["crate", "simple-crate@1.2.3"] },
      {
        spawnSync: (command, args, _opts) => {
          if (command === "cargo") {
            return {
              status: 0,
              stdout: JSON.stringify({
                packages: [
                  {
                    name: "simple-crate",
                    version: "1.2.3",
                    manifest_path: "/cargo/registry/simple-crate-1.2.3/Cargo.toml",
                    targets: [{ name: "simple_crate", kind: ["lib"] }],
                  },
                ],
              }),
              stderr: "",
            } as any;
          }

          if (command === "tsubabindgen") {
            const outIdx = args.indexOf("--out");
            const outDir = outIdx === -1 ? undefined : String(args[outIdx + 1]);
            if (!outDir) throw new Error("test stub: expected --out");
            mkdirSync(outDir, { recursive: true });
            writeFileSync(
              join(outDir, "package.json"),
              JSON.stringify({ name: "@tsuba/simple-crate", version: "0.0.0" }) + "\n",
              "utf-8"
            );
            writeFileSync(
              join(outDir, "tsuba.bindings.json"),
              JSON.stringify(
                {
                  schema: 1,
                  kind: "crate",
                  crate: { name: "simple_crate", package: "simple-crate", version: "1.2.3" },
                  modules: { "@tsuba/simple-crate/index.js": "simple_crate" },
                },
                null,
                2
              ) + "\n",
              "utf-8"
            );
            return { status: 0 } as any;
          }

          throw new Error(`test stub: unexpected command ${command}`);
        },
      }
    );

    const json = JSON.parse(readFileSync(join(projectRoot, "tsuba.json"), "utf-8")) as any;
    expect(json.deps.crates).to.deep.equal([{ id: "simple_crate", package: "simple-crate", version: "1.2.3" }]);
  });
});
