import type { i32 } from "@tsuba/core/types.js";

type Shape =
  | { kind: "circle"; radius: i32 }
  | { kind: "square"; side: i32 };

function area(shape: Shape): void {
  switch (shape.kind) {
    case "circle":
      void shape.radius;
      break;
  }
}

export function main(): void {
  void area;
}
