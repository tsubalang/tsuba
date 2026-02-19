import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

function add(a: i32, b: i32): i32 {
  return (a + b) as i32;
}

export function main(): void {
  const x = add(1 as i32, 2 as i32);
  println("host-basic {}", x);
}
