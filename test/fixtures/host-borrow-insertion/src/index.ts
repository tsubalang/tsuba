import type { i32, mut, mutref, ref } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

class Counter {
  value: i32 = 0 as i32;

  constructor(value: i32) {
    this.value = value;
  }

  inc(this: mutref<Counter>): void {
    this.value = (this.value + (1 as i32)) as i32;
  }

  read(this: ref<Counter>): i32 {
    return this.value;
  }
}

function tick(counter: mutref<Counter>): void {
  counter.inc();
  counter.inc();
}

export function main(): void {
  let counter: mut<Counter> = new Counter(0 as i32);
  tick(counter);
  println("borrow {}", counter.read());
}
