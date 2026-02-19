import type { ref, mutref } from "@tsuba/core/types.js";

interface Mutates {
  update(this: mutref<this>): void;
}

class Item implements Mutates {
  update(this: ref<Item>): void {}
}

export function main(): void {
  void Item;
}
