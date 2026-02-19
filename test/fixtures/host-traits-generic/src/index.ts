import type { i32, ref } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

interface Readable {
  read(this: ref<this>): i32;
}

interface Named extends Readable {
  name(this: ref<this>): i32;
}

interface Doubler {
  twice(this: ref<this>, x: i32): i32;
}

interface PickerLike<T extends Named> {
  pick(this: ref<this>, value: ref<T>): i32;
}

class Adder implements Named, Doubler {
  base: i32 = 0 as i32;

  constructor(base: i32) {
    this.base = base;
  }

  read(this: ref<Adder>): i32 {
    return this.base;
  }

  name(this: ref<Adder>): i32 {
    return (this.base + (1 as i32)) as i32;
  }

  twice(this: ref<Adder>, x: i32): i32 {
    return (x + x) as i32;
  }
}

class Picker implements PickerLike<Adder> {
  pick(this: ref<Picker>, value: ref<Adder>): i32 {
    return value.read();
  }
}

export function main(): void {
  const a = new Adder(9 as i32);
  const p = new Picker();
  const total = (a.name() + p.pick(a) + a.twice(2 as i32)) as i32;
  println("trait {}", total);
}
