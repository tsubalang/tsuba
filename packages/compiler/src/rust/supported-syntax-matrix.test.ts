import { expect } from "chai";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileHostToRust } from "./host.js";

type SupportedCase = {
  readonly name: string;
  readonly entrySource: string;
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly runtimeKind?: "none" | "tokio";
  readonly expectedRust: readonly string[];
  readonly expectedKernels?: readonly string[];
};

describe("@tsuba/compiler supported syntax matrix", () => {
  function repoRoot(): string {
    const here = fileURLToPath(import.meta.url);
    return resolve(join(dirname(here), "../../../.."));
  }

  function makeRepoTempDir(prefix: string): string {
    const base = join(repoRoot(), ".tsuba");
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }

  function expectCompiles(def: SupportedCase): void {
    const dir = makeRepoTempDir("compiler-supported-matrix-");
    const entry = join(dir, "main.ts");
    writeFileSync(entry, def.entrySource, "utf-8");
    for (const [rel, source] of Object.entries(def.extraFiles ?? {})) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, source, "utf-8");
    }

    const out = compileHostToRust({ entryFile: entry, runtimeKind: def.runtimeKind });
    for (const fragment of def.expectedRust) {
      expect(out.mainRs, `${def.name}: expected Rust fragment '${fragment}'`).to.contain(fragment);
    }
    for (const fragment of def.expectedKernels ?? []) {
      const kernels = out.kernels.map((k) => k.cuSource).join("\n");
      expect(kernels, `${def.name}: expected kernel fragment '${fragment}'`).to.contain(fragment);
    }
  }

  const cases: readonly SupportedCase[] = [
    {
      name: "entry contract supports exported main returning void",
      entrySource: [
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["fn main()", "return;"],
    },
    {
      name: "entry contract supports Result<void, E> with q/unsafe markers",
      entrySource: [
        'import { q, unsafe } from "@tsuba/core/lang.js";',
        'import { Ok } from "@tsuba/std/prelude.js";',
        'import type { Result, i32 } from \"@tsuba/core/types.js\";',
        "",
        "declare function mayFail(): Result<i32, i32>;",
        "",
        "export function main(): Result<void, i32> {",
        "  const x = unsafe(() => 1 as i32);",
        "  const y = q(mayFail());",
        "  void x;",
        "  void y;",
        "  return Ok();",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["fn main() -> Result<(), i32>", "unsafe { (1) as i32 }", "(mayFail())?", "return Ok(())"],
    },
    {
      name: "expression strings and closures lower deterministically",
      entrySource: [
        'import { move } from "@tsuba/core/lang.js";',
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "",
        "export function main(): void {",
        "  const msg = `n=${1 as i32}`;",
        "  const f = (x: i32 = 3 as i32): i32 => {",
        "    const y = (x + (1 as i32)) as i32;",
        "    return y;",
        "  };",
        "  const g = move((x: i32): i32 => (x + (2 as i32)) as i32);",
        "  const a = f();",
        "  const b = g(2 as i32);",
        "  void msg;",
        "  void a;",
        "  void b;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["format!(", "let f = |x: Option<i32>|", "let x: i32 = x.unwrap_or((3) as i32);", "let g = move |x: i32|"],
    },
    {
      name: "async functions lower with tokio runtime policy",
      runtimeKind: "tokio",
      entrySource: [
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "",
        "async function add(a: i32, b: i32): Promise<i32> {",
        "  return (a + b) as i32;",
        "}",
        "",
        "export async function main(): Promise<void> {",
        "  const x = await add(1 as i32, 2 as i32);",
        "  void x;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["#[tokio::main]", "async fn main()", "async fn add(a: i32, b: i32) -> i32", "let x = (add("],
    },
    {
      name: "functions, traits, and generic bounds compile in v0 subset",
      entrySource: [
        'import type { i32, ref } from \"@tsuba/core/types.js\";',
        "",
        "interface Ordered {",
        "  rank(this: ref<this>): i32;",
        "}",
        "",
        "class Score implements Ordered {",
        "  value: i32 = 0 as i32;",
        "  constructor(value: i32) {",
        "    this.value = value;",
        "  }",
        "  rank(this: ref<Score>): i32 {",
        "    return this.value;",
        "  }",
        "}",
        "",
        "function pick<T extends Ordered>(left: T, right: T): T {",
        "  if (left.rank() > right.rank()) {",
        "    return left;",
        "  }",
        "  return right;",
        "}",
        "",
        "export function main(): void {",
        "  const winner = pick(new Score(3 as i32), new Score(2 as i32));",
        "  void winner;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["trait Ordered", "impl Ordered for Score", "fn pick<T: Ordered>(left: T, right: T) -> T"],
    },
    {
      name: "plain type aliases (including generic aliases) are emitted",
      entrySource: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "",
        "type UserId = i32;",
        "type Pair<T> = [T, T];",
        "",
        "function id(x: UserId): UserId {",
        "  return x;",
        "}",
        "",
        "export function main(): void {",
        "  const p: Pair<i32> = [1 as i32, 2 as i32];",
        "  const x = id(3 as i32);",
        "  void p;",
        "  void x;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["type UserId = i32;", "type Pair<T> = (T, T);", "fn id(x: UserId) -> UserId"],
    },
    {
      name: "contextual and uncontextual object literals lower deterministically",
      entrySource: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "",
        "type Pair = { left: i32; right: i32; };",
        "function sum(pair: Pair): i32 {",
        "  return (pair.left + pair.right) as i32;",
        "}",
        "",
        "export function main(): void {",
        "  const a = sum({ left: 1 as i32, right: 2 as i32 });",
        "  const b = { x: 3 as i32, y: 4 as i32 };",
        "  void a;",
        "  void b;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["struct Pair", "sum(Pair { left: (1) as i32, right: (2) as i32 })", "struct __Anon_"],
    },
    {
      name: "discriminated unions and scalar switch lower deterministically",
      entrySource: [
        "import type { i32 } from \"@tsuba/core/types.js\";",
        "",
        "type Shape =",
        '  | { kind: "circle"; radius: i32 }',
        '  | { kind: "square"; side: i32 };',
        "",
        "function area(shape: Shape): i32 {",
        "  switch (shape.kind) {",
        '    case "circle":',
        "      return shape.radius;",
        '    case "square":',
        "      return shape.side;",
        "  }",
        "}",
        "",
        "function classify(x: i32): i32 {",
        "  switch (x) {",
        "    case 0:",
        "      return 1 as i32;",
        "    default:",
        "      return 2 as i32;",
        "  }",
        "}",
        "",
        "export function main(): void {",
        '  const a: Shape = { kind: "circle", radius: 1 as i32 };',
        "  const r = area(a);",
        "  const c = classify(0 as i32);",
        "  void r;",
        "  void c;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["enum Shape", "match shape", "__tsuba_switch_0 == 0", "Shape::Circle { radius: (1) as i32 }"],
    },
    {
      name: "relative project module imports lower to mod/use wiring",
      entrySource: [
        'import { add } from "./math.js";',
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "",
        "export function main(): void {",
        "  const x = add(1 as i32, 2 as i32);",
        "  void x;",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "math.ts": [
          'import type { i32 } from \"@tsuba/core/types.js\";',
          "",
          "export function add(a: i32, b: i32): i32 {",
          "  return (a + b) as i32;",
          "}",
          "",
        ].join("\n"),
      },
      expectedRust: ["mod math {", "use crate::math::add;", "let x = add((1) as i32, (2) as i32);"],
    },
    {
      name: "annotation markers lower to Rust attributes",
      entrySource: [
        'import { annotate, attr, tokens } from "@tsuba/core/lang.js";',
        'import type { i32 } from \"@tsuba/core/types.js\";',
        "",
        "class User {",
        "  id: i32 = 0 as i32;",
        "}",
        "",
        'annotate(User, attr("repr", tokens`C`));',
        "",
        "export function main(): void {",
        "  return;",
        "}",
        "",
      ].join("\n"),
      expectedRust: ["#[repr(C)]", "struct User"],
    },
    {
      name: "kernel declarations and launches lower to runtime + CUDA artifacts",
      entrySource: [
        'import { deviceMalloc } from "@tsuba/gpu/lang.js";',
        'import type { f32, u32 } from \"@tsuba/core/types.js\";',
        'import { add as addKernel } from "./add.js";',
        "",
        "export function main(): void {",
        "  const n = 16 as u32;",
        "  const a = deviceMalloc<f32>(n);",
        "  addKernel.launch({ grid: [1, 1, 1], block: [16, 1, 1] } as const, a, a, a, n);",
        "}",
        "",
      ].join("\n"),
      extraFiles: {
        "add.ts": [
          'import { kernel, threadIdxX, blockIdxX, blockDimX } from "@tsuba/gpu/lang.js";',
          'import type { global_ptr } from "@tsuba/gpu/types.js";',
          'import type { f32, u32 } from \"@tsuba/core/types.js\";',
          "",
          'export const add = kernel({ name: "add" } as const, (a: global_ptr<f32>, b: global_ptr<f32>, out: global_ptr<f32>, n: u32): void => {',
          "  const i = (blockIdxX() * blockDimX() + threadIdxX()) as u32;",
          "  if (i < n) {",
          "    out[i] = a[i] + b[i];",
          "  }",
          "});",
          "",
        ].join("\n"),
      },
      expectedRust: ["__tsuba_cuda::device_malloc::<f32>(n)", "__tsuba_cuda::launch_add(1, 1, 1, 16, 1, 1"],
      expectedKernels: ['extern "C" __global__ void add(', "out[i] = (a[i] + b[i]);"],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expectCompiles(c);
    });
  }
});
