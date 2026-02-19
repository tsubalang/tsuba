import type { i32, mut, mutref } from "@tsuba/core/types.js";

function update(x: mutref<i32>): void {
  void x;
}

export function main(): void {
  let v: mut<i32> = 1 as i32;
  update(v + (1 as i32));
}
