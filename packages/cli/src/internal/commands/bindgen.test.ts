import { expect } from "chai";

import { parseBindgenArgs, runBindgen } from "./bindgen.js";

describe("@tsuba/cli bindgen", () => {
  it("parses args and invokes bindgen generation", async () => {
    const calls: {
      manifestPath: string;
      outDir: string;
      packageName?: string;
      bundleCrate: boolean;
    }[] = [];
    await runBindgen(
      {
        dir: "/repo",
        argv: [
          "--manifest-path",
          "crate/Cargo.toml",
          "--out",
          "out",
          "--package",
          "@tsuba/x",
          "--bundle-crate",
        ],
      },
      {
        generate: (opts) => {
          calls.push(opts);
        },
      }
    );

    expect(calls).to.have.length(1);
    expect(calls[0]).to.deep.equal({
      manifestPath: "/repo/crate/Cargo.toml",
      outDir: "/repo/out",
      packageName: "@tsuba/x",
      bundleCrate: true,
    });
  });

  it("rejects missing required args", () => {
    expect(() => parseBindgenArgs({ dir: "/repo", argv: ["--out", "x"] })).to.throw(
      "missing required --manifest-path"
    );
    expect(() => parseBindgenArgs({ dir: "/repo", argv: ["--manifest-path", "Cargo.toml"] })).to.throw(
      "missing required --out"
    );
  });

  it("resolves --manifest-path and --out relative to the invocation directory", async () => {
    const calls: {
      manifestPath: string;
      outDir: string;
      packageName?: string;
      bundleCrate: boolean;
    }[] = [];
    await runBindgen(
      {
        dir: "/repo/packages/app/docs",
        argv: ["--manifest-path", "../../crate/Cargo.toml", "--out", "../../generated/bindings"],
      },
      {
        generate: (opts) => {
          calls.push(opts);
        },
      }
    );

    expect(calls).to.have.length(1);
    expect(calls[0]).to.deep.equal({
      manifestPath: "/repo/packages/crate/Cargo.toml",
      outDir: "/repo/packages/generated/bindings",
      packageName: undefined,
      bundleCrate: false,
    });
  });
});
