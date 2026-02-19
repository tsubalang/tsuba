import type { i32, ref } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

interface AdderLike {
  add(this: ref<this>, x: i32): i32;
}

class Adder implements AdderLike {
  base: i32 = 0 as i32;

  constructor(base: i32) {
    this.base = base;
  }

  add(this: ref<Adder>, x: i32): i32 {
    return (this.base + x) as i32;
  }
}

export function main(): void {
  const a = new Adder(9 as i32);
  println("trait {}", a.add(4 as i32));
}
