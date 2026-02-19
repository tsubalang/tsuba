import type { i32, ref } from "@tsuba/core/types.js";

interface Reader {
  read?(this: ref<this>): i32;
}

export function main(): void {
  return;
}
