import { argv, cwd, exit } from "node:process";

import { runBuild } from "./internal/commands/build.js";
import { runInit } from "./internal/commands/init.js";

type Cmd = "init" | "build" | "help";

function usage(): void {
  // Keep this minimal for now.
  // v0 is a scaffold + deterministic codegen toolchain, not a template generator.
  console.log(
    [
      "tsuba v0",
      "",
      "Usage:",
      "  tsuba init",
      "  tsuba build",
      "",
    ].join("\n")
  );
}

function parseCommand(args: readonly string[]): Cmd {
  const [cmd] = args;
  if (!cmd) return "help";
  if (cmd === "init" || cmd === "build" || cmd === "help") return cmd;
  return "help";
}

async function main(): Promise<void> {
  const cmd = parseCommand(argv.slice(2));
  switch (cmd) {
    case "init":
      await runInit({ dir: cwd() });
      return;
    case "build":
      await runBuild({ dir: cwd() });
      return;
    default:
      usage();
      exit(1);
  }
}

void main();
