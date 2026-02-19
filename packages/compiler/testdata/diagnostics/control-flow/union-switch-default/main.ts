import type { i32 } from "@tsuba/core/types.js";

type Shape =
  | { kind: "circle"; radius: i32 }
  | { kind: "square"; side: i32 };

function area(shape: Shape): i32 {
  switch (shape.kind) {
    case "circle":
      return shape.radius;
    default:
      return 0 as i32;
    case "square":
      return shape.side;
  }
}

export function main(): void {
  void area;
}
