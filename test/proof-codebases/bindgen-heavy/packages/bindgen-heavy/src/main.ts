import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

import { WeightedScorer, stable_code, weighted_sum } from "@tsuba/proof-analytics/index.js";
import { bucketize } from "@tsuba/proof-analytics/metrics.js";
import { classify_route } from "@tsuba/proof-analytics/routing.js";

function evaluate(routeId: i32, status: i32): i32 {
  const scorer = new WeightedScorer(3 as i32, 2 as i32);
  const left = scorer.apply_pair(7 as i32, 9 as i32);
  const right = weighted_sum(11 as i32, 5 as i32, 2 as i32);
  const stable = stable_code(routeId, status);
  const severity = bucketize(status);
  const route = classify_route(routeId);
  void severity;
  void route;
  return (((left + right) as i32) + stable) as i32;
}

export function main(): void {
  const score = evaluate(1 as i32, 503 as i32);
  println("proof-bindgen-heavy score={}", score);
}
