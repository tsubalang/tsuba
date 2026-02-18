// @tsuba/std/macros.js
// Standard library macros as values (no special casing in the compiler).

import type { Macro } from "@tsuba/core/types.js";

function macro(name: string): never {
  throw new Error(`@tsuba/std: '${name}' is a compile-time macro (not callable at runtime).`);
}

// A typed signature is optional; v0 keeps it permissive.
export const println = ((..._args: unknown[]) => {
  void _args;
  return macro("println");
}) as unknown as Macro<(...args: unknown[]) => void>;

export const eprintln = ((..._args: unknown[]) => {
  void _args;
  return macro("eprintln");
}) as unknown as Macro<(...args: unknown[]) => void>;
