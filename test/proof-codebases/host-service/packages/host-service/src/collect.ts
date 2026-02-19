import type { i32, mut, mutref, u32 } from "@tsuba/core/types.js";
import type { RouteEvent, Summary } from "./types.js";

function latency(seed: u32): u32 {
  let base: mut<u32> = (seed * (17 as u32)) as u32;
  while ((base as i32) >= (90 as i32)) {
    base = (base - (90 as u32)) as u32;
  }
  return (base + (10 as u32)) as u32;
}

export function generateBatch(seed: u32): RouteEvent {
  const routeA = 1 as i32;
  const routeB = 2 as i32;
  const routeC = 3 as i32;
  if (seed < (8 as u32)) {
    return {
      kind: 0 as i32,
      path: routeA,
      status: (200 as i32),
      latencyMs: latency(seed),
    };
  }
  if (seed < (16 as u32)) {
    return {
      kind: 2 as i32,
      path: routeB,
      status: (500 as i32),
      latencyMs: latency((seed + (1 as u32)) as u32),
    };
  }
  if (seed > (20 as u32)) {
    return {
      kind: 1 as i32,
      path: routeC,
      status: (200 as i32),
      latencyMs: latency((seed + (2 as u32)) as u32),
    };
  }
  return {
    kind: 0 as i32,
    path: routeC,
    status: (200 as i32),
    latencyMs: latency((seed + (2 as u32)) as u32),
  };
}

export function emptySummary(): Summary {
  return {
    total: 0 as u32,
    errors: 0 as u32,
    bots: 0 as u32,
    uniquePaths: 0 as u32,
  };
}

export function applyEvent(summary: mutref<Summary>, event: RouteEvent): void {
  summary.total = (summary.total + (1 as u32)) as u32;
  if (event.path === (1 as i32)) {
    summary.uniquePaths = (1 as u32);
  } else if (event.path === (2 as i32) && summary.uniquePaths < (2 as u32)) {
    summary.uniquePaths = (2 as u32);
  } else if (event.path === (3 as i32) && summary.uniquePaths < (3 as u32)) {
    summary.uniquePaths = (3 as u32);
  }
  if (event.kind === (2 as i32)) {
    summary.errors = (summary.errors + (1 as u32)) as u32;
  } else if (event.kind === (1 as i32)) {
    summary.bots = (summary.bots + (1 as u32)) as u32;
  }
}
