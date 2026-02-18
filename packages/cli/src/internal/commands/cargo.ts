export type CargoDependency = {
  readonly name: string;
  readonly version: string;
  readonly features?: readonly string[];
};

export function mergeCargoDependencies(
  a: readonly CargoDependency[],
  b: readonly CargoDependency[]
): readonly CargoDependency[] {
  const merged = new Map<string, { version: string; features: Set<string> }>();
  for (const dep of [...a, ...b]) {
    const cur = merged.get(dep.name);
    if (!cur) {
      merged.set(dep.name, { version: dep.version, features: new Set(dep.features ?? []) });
      continue;
    }
    if (cur.version !== dep.version) {
      throw new Error(`Conflicting crate versions for '${dep.name}': '${cur.version}' vs '${dep.version}'.`);
    }
    for (const f of dep.features ?? []) cur.features.add(f);
  }
  return [...merged.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([name, v]) => {
      const features = [...v.features].sort((x, y) => x.localeCompare(y));
      return features.length === 0 ? { name, version: v.version } : { name, version: v.version, features };
    });
}

export function renderCargoToml(opts: {
  readonly crateName: string;
  readonly rustEdition: "2021" | "2024";
  readonly deps: readonly CargoDependency[];
}): string {
  const depLines = opts.deps.map((d) => {
    const version = JSON.stringify(d.version);
    if (!d.features || d.features.length === 0) return `${d.name} = ${version}`;
    const features = `[${d.features.map((f) => JSON.stringify(f)).join(", ")}]`;
    return `${d.name} = { version = ${version}, features = ${features} }`;
  });

  return [
    "[package]",
    `name = ${JSON.stringify(opts.crateName)}`,
    'version = "0.0.0"',
    `edition = ${JSON.stringify(opts.rustEdition)}`,
    "",
    "[dependencies]",
    ...depLines,
  ].join("\n");
}

