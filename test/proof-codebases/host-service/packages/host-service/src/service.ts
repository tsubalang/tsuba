import type { i32, mut, u32 } from "@tsuba/core/types.js";

import type { RouteEvent, Summary } from "./types.js";
import { applyEvent, emptySummary, generateBatch } from "./collect.js";

async function readRound(round: u32): Promise<RouteEvent> {
  return generateBatch(round);
}

export async function collectSummary(rounds: u32): Promise<Summary> {
  const summary: mut<Summary> = emptySummary();
  let i: mut<u32> = 0 as u32;
  while ((i as i32) < (rounds as i32)) {
    const event = await readRound(i);
    applyEvent(summary, event);
    i = (i + (1 as u32)) as u32;
  }
  return summary;
}
