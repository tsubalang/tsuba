import { argv, cwd, exit } from "node:process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { CompileError } from "@tsuba/compiler";

import { runBuild } from "./internal/commands/build.js";
import { runAdd } from "./internal/commands/add.js";
import { runBindgen } from "./internal/commands/bindgen.js";
import { runInit } from "./internal/commands/init.js";
import { runRun } from "./internal/commands/run.js";
import { runTest } from "./internal/commands/test.js";

export type Cmd = "init" | "add" | "build" | "run" | "test" | "bindgen" | "help";

function usage(): void {
  // Keep this minimal for now.
  // v0 is a scaffold + deterministic codegen toolchain, not a template generator.
  console.log(
    [
      "tsuba v0",
      "",
      "Usage:",
      "  tsuba init",
      "  tsuba add crate <name>@<version>",
      "  tsuba add path <name> <path-to-crate>",
      "  tsuba add npm <package>",
      "  tsuba build",
      "  tsuba run",
      "  tsuba test",
      "  tsuba bindgen --manifest-path <Cargo.toml> --out <dir> [--package <@scope/name>] [--bundle-crate]",
      "",
    ].join("\n")
  );
}

export function parseCommand(args: readonly string[]): Cmd {
  const [cmd] = args;
  if (!cmd) return "help";
  if (cmd === "init" || cmd === "add" || cmd === "build" || cmd === "run" || cmd === "test" || cmd === "bindgen" || cmd === "help") return cmd;
  return "help";
}

function posToLineCol(text: string, pos: number): { readonly line: number; readonly col: number } {
  // 1-based, like most compilers.
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

async function main(): Promise<void> {
  try {
    const cmd = parseCommand(argv.slice(2));
    switch (cmd) {
      case "init":
        await runInit({ dir: cwd() });
        return;
      case "add":
        await runAdd({ dir: cwd(), argv: argv.slice(3) });
        return;
      case "build":
        await runBuild({ dir: cwd() });
        return;
      case "run":
        await runRun({ dir: cwd(), stdio: "inherit" });
        return;
      case "test":
        await runTest({ dir: cwd(), stdio: "inherit" });
        return;
      case "bindgen":
        await runBindgen({ dir: cwd(), argv: argv.slice(3) });
        return;
      default:
        usage();
        exit(1);
    }
  } catch (err: unknown) {
    if (err instanceof CompileError && err.span) {
      try {
        const text = readFileSync(err.span.fileName, "utf-8");
        const pos = posToLineCol(text, err.span.start);
        console.error(`${err.span.fileName}:${pos.line}:${pos.col}: ${err.code}: ${err.message}`);
        exit(1);
      } catch {
        // Fall through to generic printing if source can't be read.
      }
    }
    console.error(err);
    exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
