export type CargoDependency = {
  readonly name: string;
  readonly package?: string;
  readonly features?: readonly string[];
} & ({ readonly version: string } | { readonly path: string });

export function mergeCargoDependencies(
  a: readonly CargoDependency[],
  b: readonly CargoDependency[]
): readonly CargoDependency[] {
  const merged = new Map<
    string,
    | {
        readonly kind: "version";
        readonly version: string;
        readonly package?: string;
        readonly features: Set<string>;
      }
    | { readonly kind: "path"; readonly path: string; readonly package?: string; readonly features: Set<string> }
  >();
  for (const dep of [...a, ...b]) {
    const cur = merged.get(dep.name);
    if (!cur) {
      if ("version" in dep) {
        merged.set(dep.name, {
          kind: "version",
          version: dep.version,
          package: dep.package,
          features: new Set(dep.features ?? []),
        });
      } else {
        merged.set(dep.name, { kind: "path", path: dep.path, package: dep.package, features: new Set(dep.features ?? []) });
      }
      continue;
    }
    const curPkg = cur.package ?? dep.name;
    const depPkg = dep.package ?? dep.name;
    if (curPkg !== depPkg) {
      throw new Error(`Conflicting cargo package names for '${dep.name}': '${curPkg}' vs '${depPkg}'.`);
    }
    if ("version" in dep) {
      if (cur.kind !== "version") {
        throw new Error(
          `Conflicting crate sources for '${dep.name}': path '${cur.path}' vs version '${dep.version}'.`
        );
      }
      if (cur.version !== dep.version) {
        throw new Error(`Conflicting crate versions for '${dep.name}': '${cur.version}' vs '${dep.version}'.`);
      }
      for (const f of dep.features ?? []) cur.features.add(f);
      continue;
    }
    if (cur.kind !== "path") {
      throw new Error(
        `Conflicting crate sources for '${dep.name}': version '${cur.version}' vs path '${dep.path}'.`
      );
    }
    if (cur.path !== dep.path) {
      throw new Error(`Conflicting crate paths for '${dep.name}': '${cur.path}' vs '${dep.path}'.`);
    }
    for (const f of dep.features ?? []) cur.features.add(f);
  }
  return [...merged.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([name, v]) => {
      const features = [...v.features].sort((x, y) => x.localeCompare(y));
      if (v.kind === "version") {
        const base = v.package ? { name, package: v.package } : { name };
        return features.length === 0
          ? { ...base, version: v.version }
          : { ...base, version: v.version, features };
      }
      const base = v.package ? { name, package: v.package } : { name };
      return features.length === 0 ? { ...base, path: v.path } : { ...base, path: v.path, features };
    });
}

export function renderCargoToml(opts: {
  readonly crateName: string;
  readonly rustEdition: "2021" | "2024";
  readonly deps: readonly CargoDependency[];
}): string {
  const depLines = opts.deps.map((d) => {
    const features = d.features && d.features.length > 0 ? `[${d.features.map((f) => JSON.stringify(f)).join(", ")}]` : undefined;
    const packageField = d.package && d.package !== d.name ? `package = ${JSON.stringify(d.package)}` : undefined;
    if ("version" in d) {
      const version = JSON.stringify(d.version);
      if (!features && !packageField) return `${d.name} = ${version}`;
      const parts = [`version = ${version}`, packageField, features ? `features = ${features}` : undefined].filter((p): p is string => typeof p === "string");
      return `${d.name} = { ${parts.join(", ")} }`;
    }
    const path = JSON.stringify(d.path);
    if (!features && !packageField) return `${d.name} = { path = ${path} }`;
    const parts = [`path = ${path}`, packageField, features ? `features = ${features}` : undefined].filter((p): p is string => typeof p === "string");
    return `${d.name} = { ${parts.join(", ")} }`;
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
