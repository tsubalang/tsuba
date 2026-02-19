import type { i32, ref } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

interface Scoreable {
  score(this: ref<this>): i32;
}

class Pair implements Scoreable {
  left: i32 = 0 as i32;
  right: i32 = 0 as i32;

  constructor(left: i32, right: i32) {
    this.left = left;
    this.right = right;
  }

  score(this: ref<Pair>): i32 {
    return (this.left + this.right) as i32;
  }
}

type Shape =
  | { kind: "circle"; radius: i32 }
  | { kind: "square"; side: i32 };

function area(s: Shape): i32 {
  switch (s.kind) {
    case "circle":
      return s.radius;
    case "square":
      return s.side;
  }
}

function scoreOne<T extends Scoreable>(x: T): i32 {
  return x.score();
}

export function main(): void {
  const pair = new Pair(3 as i32, 4 as i32);
  const total = (scoreOne(pair) + area({ kind: "square", side: 5 as i32 })) as i32;
  println("object-context {}", total);
}
