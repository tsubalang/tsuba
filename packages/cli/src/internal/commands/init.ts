import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type InitArgs = {
  readonly dir: string;
};

type WorkspaceConfig = {
  readonly schema: 1;
  readonly rustEdition: "2021" | "2024";
  readonly packagesDir: string;
  readonly generatedDirName: string;
  readonly cargoTargetDir: string;
  readonly gpu: {
    readonly backend: "none" | "cuda";
  };
  readonly runtime: {
    readonly kind: "none" | "tokio";
  };
};

type ProjectConfig = {
  readonly schema: 1;
  readonly name: string;
  readonly kind: "bin";
  readonly entry: string;
  readonly gpu: {
    readonly enabled: boolean;
  };
  readonly crate: {
    readonly name: string;
  };
};

function toSnakeCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export async function runInit(args: InitArgs): Promise<void> {
  const root = resolve(args.dir);
  const projectName = basename(root);
  const packagesDir = join(root, "packages");
  const projectDir = join(packagesDir, projectName);

  const ws: WorkspaceConfig = {
    schema: 1,
    rustEdition: "2021",
    packagesDir: "packages",
    generatedDirName: "generated",
    cargoTargetDir: ".tsuba/target",
    gpu: { backend: "none" },
    runtime: { kind: "none" },
  };

  mkdirSync(packagesDir, { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });

  writeFileSync(join(root, "tsuba.workspace.json"), JSON.stringify(ws, null, 2) + "\n", "utf-8");

  const project: ProjectConfig = {
    schema: 1,
    name: projectName,
    kind: "bin",
    entry: "src/main.ts",
    gpu: { enabled: false },
    crate: { name: toSnakeCase(projectName) },
  };
  writeFileSync(join(projectDir, "tsuba.json"), JSON.stringify(project, null, 2) + "\n", "utf-8");

  writeFileSync(
    join(projectDir, "src", "main.ts"),
    [
      "export function main(): void {",
      "  // v0: host-only codegen. Add @tsuba/std and call std macros once the toolchain is in place.",
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );
}
