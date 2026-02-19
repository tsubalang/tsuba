import type { i32, u32 } from "@tsuba/core/types.js";

export type RouteEvent =
  {
    kind: i32;
    path: i32;
    status: i32;
    latencyMs: u32;
  };

export type Summary = {
  total: u32;
  errors: u32;
  bots: u32;
  uniquePaths: u32;
};
