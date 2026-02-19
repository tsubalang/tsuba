export type RustSourceMapEntry = {
  readonly rustLine: number;
  readonly rustColumn: number;
  readonly tsFileName: string;
  readonly tsStart: number;
  readonly tsEnd: number;
};

export type RustSourceMap = {
  readonly schema: 1;
  readonly kind: "rust-source-map";
  readonly entries: readonly RustSourceMapEntry[];
};

function parseSpanComment(line: string): { readonly fileName: string; readonly start: number; readonly end: number } | undefined {
  const trimmed = line.trimStart();
  const prefix = "// tsuba-span: ";
  if (!trimmed.startsWith(prefix)) return undefined;
  const rest = trimmed.slice(prefix.length);
  const last = rest.lastIndexOf(":");
  if (last === -1) return undefined;
  const secondLast = rest.lastIndexOf(":", last - 1);
  if (secondLast === -1) return undefined;
  const fileName = rest.slice(0, secondLast);
  const startText = rest.slice(secondLast + 1, last);
  const endText = rest.slice(last + 1);
  const start = Number.parseInt(startText, 10);
  const end = Number.parseInt(endText, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (start < 0 || end < start) return undefined;
  return { fileName, start, end };
}

export function buildRustSourceMap(mainRs: string): RustSourceMap {
  const entries: RustSourceMapEntry[] = [];
  const lines = mainRs.split(/\r?\n/g);
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseSpanComment(lines[i]!);
    if (!parsed) continue;
    entries.push({
      rustLine: i + 1,
      rustColumn: 1,
      tsFileName: parsed.fileName,
      tsStart: parsed.start,
      tsEnd: parsed.end,
    });
  }
  return Object.freeze({
    schema: 1,
    kind: "rust-source-map",
    entries: Object.freeze(entries),
  });
}

export function mapRustLineToTs(
  map: RustSourceMap,
  rustLine: number
): { readonly fileName: string; readonly start: number; readonly end: number } | undefined {
  let best: RustSourceMapEntry | undefined;
  for (const entry of map.entries) {
    if (entry.rustLine > rustLine) break;
    best = entry;
  }
  if (!best) return undefined;
  return { fileName: best.tsFileName, start: best.tsStart, end: best.tsEnd };
}
