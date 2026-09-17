// The worker picker's options, from the repo's adopters.json5 — the same list
// the site's demo and the wallet integration guide show.
//
// The file is JSON5, which no bundler reads natively, so build.mjs parses it
// and injects the result here as `__ADOPTERS__`. That keeps one source of truth
// for "which workers are published" rather than a copy that goes stale.

declare const __ADOPTERS__: { workers: KnownWorker[] };

type KnownWorker = {
  id: string;
  label: string;
  specifier: string;
  note?: string;
  exampleConfig?: unknown;
  exampleConfigNote?: string;
};

export type Preset = {
  id: string;
  label: string;
  specifier: string;
  /** JSON text prefilled into the config box; blank when there is no example. */
  config: string;
  note?: string;
  configNote?: string;
};

/**
 * `JSON.stringify(value, null, 2)`, except an array of primitives stays on one
 * line. Plain stringify explodes `["…"]` across three lines, turning a one-key
 * config into a five-line block in a box that is only three rows tall.
 */
function prettyJson(value: unknown, indent = ""): string {
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    }
    return `[\n${value.map((v) => inner + prettyJson(v, inner)).join(",\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const body = entries
      .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${prettyJson(v, inner)}`)
      .join(",\n");
    return `{\n${body}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const PRESETS: Preset[] = [
  ...__ADOPTERS__.workers.map((w) => ({
    id: w.id,
    label: w.label,
    specifier: w.specifier,
    config: w.exampleConfig === undefined ? "" : prettyJson(w.exampleConfig),
    note: w.note,
    configNote: w.exampleConfigNote,
  })),
  {
    id: "custom",
    label: "Custom — paste a specifier",
    specifier: "",
    config: "",
    note: "Any IWorkerSpecifier address, plus whatever config that worker expects.",
  },
];
