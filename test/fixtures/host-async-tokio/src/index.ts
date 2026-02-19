import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

async function compute(): Promise<i32> {
  return 7 as i32;
}

export async function main(): Promise<void> {
  const value = await compute();
  println("tokio {}", value);
}
