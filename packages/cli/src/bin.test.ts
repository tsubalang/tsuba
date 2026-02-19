import { expect } from "chai";

import { parseCommand } from "./bin.js";

describe("@tsuba/cli command parser", () => {
  it("classifies supported commands", () => {
    expect(parseCommand(["init"])).to.equal("init");
    expect(parseCommand(["add"])).to.equal("add");
    expect(parseCommand(["build"])).to.equal("build");
    expect(parseCommand(["run"])).to.equal("run");
    expect(parseCommand(["test"])).to.equal("test");
    expect(parseCommand(["bindgen"])).to.equal("bindgen");
    expect(parseCommand(["help"])).to.equal("help");
  });

  it("classifies missing and unknown commands as help", () => {
    expect(parseCommand([])).to.equal("help");
    expect(parseCommand(["unknown"])).to.equal("help");
    expect(parseCommand(["foo", "bar"])).to.equal("help");
  });
});
