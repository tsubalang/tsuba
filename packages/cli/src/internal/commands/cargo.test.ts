import { expect } from "chai";

import { mergeCargoDependencies, renderCargoToml } from "./cargo.js";

describe("@tsuba/cli cargo helpers", () => {
  it("merges crate deps deterministically and unions features", () => {
    const merged = mergeCargoDependencies(
      [{ name: "tokio", version: "1.37", features: ["macros"] }],
      [
        { name: "serde", version: "1.0" },
        { name: "tokio", version: "1.37", features: ["rt-multi-thread"] },
      ]
    );
    expect(merged).to.deep.equal([
      { name: "serde", version: "1.0" },
      { name: "tokio", version: "1.37", features: ["macros", "rt-multi-thread"] },
    ]);
  });

  it("errors on conflicting crate versions", () => {
    let err: unknown;
    try {
      mergeCargoDependencies([{ name: "axum", version: "0.7.5" }], [{ name: "axum", version: "0.7.4" }]);
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("Conflicting crate versions");
  });

  it("errors on conflicting crate sources (version vs path)", () => {
    let err: unknown;
    try {
      mergeCargoDependencies([{ name: "simple", version: "0.0.0" }], [{ name: "simple", path: "/tmp/simple" }]);
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("Conflicting crate sources");
  });

  it("renders Cargo.toml with feature deps as inline tables", () => {
    const toml = renderCargoToml({
      crateName: "my_api",
      rustEdition: "2021",
      deps: [
        { name: "serde", version: "1.0", features: ["derive"] },
        { name: "axum", version: "0.7.5" },
      ],
    });
    expect(toml).to.contain('name = "my_api"');
    expect(toml).to.contain('edition = "2021"');
    expect(toml).to.contain('axum = "0.7.5"');
    expect(toml).to.contain('serde = { version = "1.0", features = ["derive"] }');
  });

  it("renders Cargo.toml with path deps", () => {
    const toml = renderCargoToml({
      crateName: "my_api",
      rustEdition: "2021",
      deps: [
        { name: "simple", path: "/tmp/simple" },
        { name: "serde", version: "1.0", features: ["derive"] },
      ],
    });
    expect(toml).to.contain('simple = { path = "/tmp/simple" }');
    expect(toml).to.contain('serde = { version = "1.0", features = ["derive"] }');
  });
});
