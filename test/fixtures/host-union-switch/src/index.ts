import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

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

export function main(): void {
  const s: Shape = { kind: "square", side: 9 as i32 };
  println("union {}", area(s));
}
