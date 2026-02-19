import type { i32, mut, ref, mutref } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

class Counter {
  value: i32 = 0 as i32;

  constructor(seed: i32) {
    this.value = seed;
  }

  inc(this: mutref<Counter>): void {
    this.value = (this.value + (1 as i32)) as i32;
  }

  get(this: ref<Counter>): i32 {
    return this.value;
  }
}

export function main(): void {
  let counter: mut<Counter> = new Counter(4 as i32);
  counter.inc();
  counter.inc();
  println("class-struct {}", counter.get());
}
