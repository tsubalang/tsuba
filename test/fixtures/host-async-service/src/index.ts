import { q } from "@tsuba/core/lang.js";
import { Ok, println } from "@tsuba/std/prelude.js";
import type { i32, Result, String } from "@tsuba/core/types.js";

async function readStore(id: i32): Promise<Result<i32, String>> {
  return Ok((id + (35 as i32)) as i32);
}

async function handle(id: i32): Promise<Result<void, String>> {
  const value = q(await readStore(id));
  println("service {}", value);
  return Ok();
}

export async function main(): Promise<void> {
  await handle(7 as i32);
}
