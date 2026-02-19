import type { u32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

import { collectSummary } from "./service.js";

export async function main(): Promise<void> {
  const summary = await collectSummary(24 as u32);
  println(
    "proof-host-service total={} errors={} bots={} unique={}",
    summary.total,
    summary.errors,
    summary.bots,
    summary.uniquePaths
  );
}
