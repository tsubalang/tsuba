import { expect } from "chai";

import { parseBindgenArgs, runBindgen } from "./bindgen.js";

describe("@tsuba/cli bindgen", () => {
  it("parses args and invokes tsubabindgen", async () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
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
        spawn: (cmd, args, _opts) => {
          calls.push({ cmd, args });
          return { status: 0 } as any;
        },
      }
    );

    expect(calls).to.have.length(1);
    expect(calls[0]!.cmd).to.equal("tsubabindgen");
    expect(calls[0]!.args).to.deep.equal([
      "--manifest-path",
      "/repo/crate/Cargo.toml",
      "--out",
      "/repo/out",
      "--package",
      "@tsuba/x",
      "--bundle-crate",
    ]);
  });

  it("rejects missing required args", () => {
    expect(() => parseBindgenArgs({ dir: "/repo", argv: ["--out", "x"] })).to.throw(
      "missing required --manifest-path"
    );
    expect(() => parseBindgenArgs({ dir: "/repo", argv: ["--manifest-path", "Cargo.toml"] })).to.throw(
      "missing required --out"
    );
  });
});
