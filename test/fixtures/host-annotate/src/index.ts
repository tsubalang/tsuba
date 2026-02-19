import { annotate, attr, tokens } from "@tsuba/core/lang.js";
import type { i32 } from "@tsuba/core/types.js";
import { println } from "@tsuba/std/prelude.js";

class User {
  id: i32 = 0 as i32;
}

annotate(User, attr("repr", tokens`C`));

export function main(): void {
  println("annotate ok");
}
