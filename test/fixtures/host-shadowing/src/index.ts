import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

export function main(): void {
  const x = 1 as i32;
  {
    const x = 2 as i32;
    println("inner {}", x);
  }
  println("shadow {}", x);
}
