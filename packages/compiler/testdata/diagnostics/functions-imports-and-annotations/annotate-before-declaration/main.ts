import { annotate, attr, tokens } from "@tsuba/core/lang.js";

annotate(main, attr("inline", tokens`always`));

export function main(): void {
  return;
}
