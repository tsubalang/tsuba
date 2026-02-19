import { expect } from "chai";

import { move, panic, q, todo, tokens, unreachable } from "./lang.js";
import type { Result } from "./types.js";

describe("@tsuba/core markers", () => {
  it("throws if a marker is called at runtime", () => {
    const r = { ok: true, value: 123 } as const satisfies Result<number, never>;
    expect(() => q(r)).to.throw(/compile-time marker/i);
    expect(() => move(() => 1)).to.throw(/compile-time marker/i);
    expect(() => panic("boom")).to.throw(/compile-time marker/i);
    expect(() => todo("later")).to.throw(/compile-time marker/i);
    expect(() => unreachable("never")).to.throw(/compile-time marker/i);
    expect(() => tokens`hi`).to.throw(/compile-time marker/i);
  });
});
