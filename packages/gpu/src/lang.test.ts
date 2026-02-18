import { expect } from "chai";

import { threadIdxX } from "./lang.js";

describe("@tsuba/gpu markers", () => {
  it("throws if a marker is called at runtime", () => {
    expect(() => threadIdxX()).to.throw(/compile-time marker/i);
  });
});

