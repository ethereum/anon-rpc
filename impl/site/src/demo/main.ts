// The balance-watcher demo: boots the anon-rpc browser harness against a
// user-supplied specifier contract and polls an address's ETH balance through
// the sandboxed worker's anonymized fetch.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import adoptersFile from "../../../../adopters.json5";

const SETTINGS_KEY = "anon-rpc-demo-settings";
const POLL_MS = 12_000; // ~mainnet block time
// The beacon deposit contract: a huge balance that changes constantly.
const DEFAULT_WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

/* --- worker presets --- */

// Workers published on mainnet, from the repo's adopters.json5 — the same
// list the wallet integration guide shows. A preset only prefills the fields
// below; any specifier address can be pasted in by hand, which switches the
// picker to "custom".
//
// `config` is the JSON text prefilled into the config textarea — §7.1 config is
// network-defined and opaque to the harness, so this page treats it as opaque
// too: it edits and parses JSON without knowing what any key means. A worker
// with an example config gets it as its starting value; every other preset
// starts blank.
type Preset = {
  id: string;
  label: string;
  specifier: string;
  config: string;
  note?: string;
  configNote?: string;
};

type KnownWorker = {
  id: string;
  label: string;
  specifier: string;
  note?: string;
  exampleConfig?: unknown;
  exampleConfigNote?: string;
};

/**
 * JSON.stringify(value, null, 2), except that an array of primitives stays on
 * one line. Plain stringify explodes `["…"]` across three lines, turning a
 * one-key config into a five-line block that then soft-wraps in the box; this
 * prints it the way it is written by hand in adopters.json5.
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
  // undefined has no JSON form; a config carrying one is malformed either way.
  return JSON.stringify(value) ?? "null";
}

const PRESETS: Preset[] = [
  ...(adoptersFile.workers as KnownWorker[]).map((w) => ({
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
    note: "Any IWorkerSpecifier address. Add whatever config that worker expects, if any.",
  },
];

const CUSTOM = PRESETS[PRESETS.length - 1];
const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? CUSTOM;
const presetBySpecifier = (addr: string): Preset | undefined =>
  PRESETS.find((p) => p.specifier && p.specifier.toLowerCase() === addr.toLowerCase());
// Probed in order on first visit to prefill the RPC fields (all mainnet,
// CORS-open). Availability shifts, hence the probe rather than a hardcode.
const PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  preset: $<HTMLSelectElement>("preset"),
  presetNote: $<HTMLParagraphElement>("preset-note"),
  bootstrap: $<HTMLInputElement>("bootstrap"),
  workerRpc: $<HTMLInputElement>("worker-rpc"),
  copy: $<HTMLButtonElement>("copy"),
  specifier: $<HTMLInputElement>("specifier"),
  config: $<HTMLTextAreaElement>("config"),
  configNote: $<HTMLParagraphElement>("config-note"),
  watch: $<HTMLInputElement>("watch"),
  toggle: $<HTMLButtonElement>("toggle"),
  pill: $<HTMLSpanElement>("pill"),
  detail: $<HTMLSpanElement>("detail"),
  balanceCard: $<HTMLDivElement>("balance-card"),
  balance: $<HTMLDivElement>("balance"),
  delta: $<HTMLDivElement>("delta"),
  checked: $<HTMLDivElement>("checked"),
  drawer: $<HTMLDivElement>("log-drawer"),
  logToggle: $<HTMLButtonElement>("log-toggle"),
  logLatest: $<HTMLSpanElement>("log-latest"),
  logCount: $<HTMLSpanElement>("log-count"),
  logClear: $<HTMLButtonElement>("log-clear"),
  log: $<HTMLDivElement>("log"),
};

/* --- §13 log drawer ------------------------------------------------------
   Two sources, one stream: this page's lifecycle events and the worker's §13
   log calls, pulled with worker.acceptLog(). The source column is what makes
   the demo's point visible — the "worker" rows were produced by hash-pinned
   code inside the sandbox, and they arrive here because the host asked for
   them, not because the harness decided where to put them. */

type LogLevel = "debug" | "info" | "warn" | "error";

/** Rows kept in the DOM. The harness retains its own; this is just the view. */
const LOG_ROWS = 500;

let logCount = 0;
let logStart = Date.now();

function logLine(source: "demo" | "worker", level: LogLevel, msg: string): void {
  // Pinned-to-bottom is checked BEFORE appending: a reader who has scrolled up
  // to look at something is not helped by being yanked back down.
  const pinned = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 24;

  const row = document.createElement("div");
  row.className = `log-row log-${level}`;
  const at = document.createElement("span");
  at.className = "log-at";
  at.textContent = `+${((Date.now() - logStart) / 1000).toFixed(1)}s`;
  const src = document.createElement("span");
  src.className = `log-src ${source}`;
  src.textContent = source;
  const text = document.createElement("span");
  text.className = "log-msg";
  // textContent, not innerHTML: worker log arguments are strings chosen by
  // the bundle, and the bundle is exactly the code this page does not trust
  // with its DOM.
  text.textContent = msg;
  row.append(at, src, text);
  els.log.appendChild(row);

  while (els.log.children.length > LOG_ROWS) els.log.removeChild(els.log.firstChild!);
  if (pinned) els.log.scrollTop = els.log.scrollHeight;

  els.logLatest.textContent = msg;
  els.logCount.textContent = String(++logCount);
}

els.logToggle.addEventListener("click", () => {
  const open = els.drawer.classList.toggle("open");
  els.logToggle.setAttribute("aria-expanded", String(open));
  if (open) els.log.scrollTop = els.log.scrollHeight;
});

els.logClear.addEventListener("click", () => {
  els.log.replaceChildren();
  logCount = 0;
  els.logCount.textContent = "0";
  els.logLatest.textContent = "cleared";
});

document.body.classList.add("has-drawer");

/**
 * Drain the worker's §13 entries into the drawer until it closes.
 *
 * One pump per worker. `acceptLog` rejects when the worker fails or is closed
 * — after yielding whatever it still held, which is why a failed boot leaves
 * its explanation in the drawer rather than only in the status line.
 */
function pumpWorkerLogs(w: AnonRpcWorker): void {
  void (async () => {
    for (;;) {
      let entry;
      try {
        entry = await w.acceptLog();
      } catch {
        return;
      }
      if (worker !== w) return; // a later worker owns the drawer now
      logLine("worker", entry.level, entry.args.map(renderLogArg).join(" "));
    }
  })();
}

/** A §13 LogArg as one readable token. Bytes are described, not dumped. */
function renderLogArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Uint8Array) return `<${a.byteLength} bytes>`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/* --- settings persistence --- */

type Settings = {
  bootstrap: string;
  workerRpc: string;
  specifier: string;
  config: string;
  watch: string;
  // Which preset the picker shows. Persisted but not one of `fields` below: it
  // backs a <select>, and the specifier address is what actually decides it.
  preset?: string;
};
// The text controls, in the order they appear (the config one is a textarea, but
// .value and .disabled are all this needs). Driven generically for prefill and
// for disabling while the watcher runs.
const fields = ["bootstrap", "workerRpc", "specifier", "config", "watch"] as const;

function readSaved(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {}; // corrupted settings: start fresh
  }
}

function persist(patch: Partial<Settings>): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSaved(), ...patch }));
}

/* --- preset picker --- */

for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  els.preset.append(opt);
}

/** Show the notes that belong to the selected preset. */
function renderPreset(p: Preset): void {
  els.presetNote.textContent = p.note ?? "";
  // Only a caveat about the example config, if the entry carries one; the
  // generic "what this field is" hint is static in the markup.
  els.configNote.textContent = p.configNote ?? "";
}

/** Adopt a preset: fill the fields it prescribes, then re-render. */
function applyPreset(p: Preset): void {
  if (p.specifier) {
    els.specifier.value = p.specifier;
    persist({ specifier: p.specifier });
  }
  // Always assigned, blank included: switching preset must not leave the
  // previous worker's config behind for this one to be started with.
  els.config.value = p.config;
  persist({ config: p.config, preset: p.id });
  renderPreset(p);
}

const saved = readSaved();
for (const f of fields) els[f].value = saved[f] ?? "";
if (!els.watch.value) els.watch.value = DEFAULT_WATCH;

// Arriving from a link that names a worker — the /adopters/ directory links
// every entry here as `?worker=<id>` — that choice wins over restored settings:
// following the link is the more recent statement of intent. An id that isn't
// known is ignored rather than landing on "custom".
const linked = new URLSearchParams(location.search).get("worker");
const linkedPreset = linked ? PRESETS.find((p) => p.id === linked) : undefined;

// Otherwise the specifier address is the source of truth for which preset is
// showing: a pasted address that matches a known one selects it, anything else
// is custom. That keeps the picker honest when settings are restored or
// hand-edited.
const initial =
  linkedPreset ??
  (els.specifier.value
    ? (presetBySpecifier(els.specifier.value) ?? CUSTOM)
    : presetById(saved.preset ?? PRESETS[0].id));
els.preset.value = initial.id;
if (linkedPreset || !els.specifier.value) applyPreset(initial);
else renderPreset(initial);

els.preset.addEventListener("change", () => applyPreset(presetById(els.preset.value)));

// Specifier, config and watch address persist as typed. The RPC URLs
// deliberately do NOT: they are only saved once proven — bootstrap when a
// worker boots through it, worker RPC when a balance query succeeds — so a typo
// never becomes the sticky default.
els.specifier.addEventListener("input", () => {
  const addr = els.specifier.value.trim();
  persist({ specifier: addr });
  // Hand-editing away from a preset's address is a switch to custom.
  const match = presetBySpecifier(addr) ?? CUSTOM;
  if (match.id !== els.preset.value) {
    els.preset.value = match.id;
    persist({ preset: match.id });
    renderPreset(match);
  }
});
els.config.addEventListener("input", () => persist({ config: els.config.value }));
els.watch.addEventListener("input", () => persist({ watch: els.watch.value.trim() }));

els.copy.addEventListener("click", () => {
  els.workerRpc.value = els.bootstrap.value;
});

// No proven RPC saved yet: probe the public list in order and prefill with
// the first endpoint that answers eth_chainId with mainnet (unless the user
// has started typing meanwhile).
if (!saved.bootstrap) {
  void (async () => {
    const restore = els.bootstrap.placeholder;
    els.bootstrap.placeholder = "checking public RPCs…";
    try {
      for (const url of PUBLIC_RPCS) {
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
            signal: AbortSignal.timeout(4000),
          });
          const body = (await resp.json()) as { result?: string };
          if (body.result !== "0x1") continue;
          if (!els.bootstrap.value) els.bootstrap.value = url;
          if (!els.workerRpc.value) els.workerRpc.value = url;
          return;
        } catch {
          // endpoint down or slow: try the next one
        }
      }
    } finally {
      els.bootstrap.placeholder = restore;
    }
  })();
}

/* --- status --- */

type State = "idle" | "boot" | "ready" | "live" | "error";

function setStatus(state: State, detail: string): void {
  els.pill.className = `pill ${state === "idle" ? "" : state}`;
  els.pill.textContent =
    { idle: "idle", boot: "starting", ready: "ready", live: "watching", error: "error" }[state];
  els.detail.textContent = detail;
}

/* --- balance formatting --- */

const WEI = 10n ** 18n;

function formatEth(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = (abs / WEI).toLocaleString("en-US");
  const frac = (abs % WEI).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}

/* --- watcher --- */

let worker: AnonRpcWorker | undefined;
let timer: number | undefined;
let lastBalance: bigint | undefined;
let running = false;

function jsonRpc(fetchImpl: typeof fetch, url: string) {
  let id = 0;
  return async (method: string, params: unknown[]): Promise<unknown> => {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
    const body = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  };
}

function validate(): Settings {
  const s = Object.fromEntries(fields.map((f) => [f, els[f].value.trim()])) as Settings;
  const isUrl = (u: string) => /^https?:\/\//.test(u);
  const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isUrl(s.bootstrap)) throw new Error("bootstrap RPC URL must be http(s)");
  if (!isUrl(s.workerRpc)) throw new Error("worker RPC URL must be http(s)");
  if (!isAddr(s.specifier)) throw new Error("specifier must be a 0x… address");
  if (!isAddr(s.watch)) throw new Error("watch address must be a 0x… address");
  // Called for its throw: unparseable JSON would otherwise surface as an opaque
  // worker startup failure much later. The value itself is taken at boot.
  parseConfig(s.config);
  return s;
}

/**
 * Worker config (§7.1) as the textarea holds it. The demo never inspects the
 * contents — the field is network-defined and the harness passes it through
 * untouched — so JSON validity is the only thing checked here. Blank means the
 * worker is started with no config at all, not with an empty object.
 */
function parseConfig(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`config must be valid JSON: ${(e as Error).message}`);
  }
}

async function tick(s: Settings): Promise<void> {
  if (!worker || !running) return;
  const t0 = Date.now();
  // In-flight: stay "ready" until the first balance lands, "watching" after.
  setStatus(
    lastBalance === undefined ? "ready" : "live",
    `eth_getBalance in flight through the worker…`,
  );
  try {
    const call = jsonRpc(worker.fetch, s.workerRpc);
    const result = await call("eth_getBalance", [s.watch, "latest"]);
    if (!running) return; // stopped while the request was in flight
    const wei = BigInt(result as string);

    // The worker RPC answered a real query: it has earned persistence.
    persist({ workerRpc: s.workerRpc });

    els.balanceCard.style.display = "block";
    els.balance.innerHTML = `${formatEth(wei)} <span class="unit">ETH</span>`;
    els.checked.textContent = `last checked ${new Date().toLocaleTimeString()}`;

    if (lastBalance !== undefined && wei !== lastBalance) {
      const diff = wei - lastBalance;
      const up = diff > 0n;
      els.delta.textContent = `${up ? "+" : "−"}${formatEth(diff < 0n ? -diff : diff, 8)} ETH`;
      els.delta.className = up ? "up" : "down";
      els.balance.classList.add(up ? "flash-up" : "flash-down");
      setTimeout(() => els.balance.classList.remove("flash-up", "flash-down"), 2500);
    }
    lastBalance = wei;
    logLine("demo", "info", `eth_getBalance OK in ${Date.now() - t0} ms — ${formatEth(wei)} ETH`);
    setStatus(
      "live",
      `request OK in ${Date.now() - t0} ms — next poll in ${POLL_MS / 1000} s`,
    );
  } catch (e) {
    if (!running) return; // stop() rejected the in-flight request: not an error
    logLine("demo", "error", `eth_getBalance failed after ${Date.now() - t0} ms: ${(e as Error).message}`);
    // Keep polling: a transient RPC failure should not stop the watcher.
    setStatus(
      "error",
      `balance query failed after ${Date.now() - t0} ms: ${(e as Error).message} — retrying in ${POLL_MS / 1000} s`,
    );
  }
}

async function start(): Promise<void> {
  let s: Settings;
  try {
    s = validate();
  } catch (e) {
    setStatus("error", (e as Error).message);
    return;
  }

  running = true;
  els.toggle.textContent = "Stop";
  for (const f of fields) els[f].disabled = true;
  els.copy.disabled = true;
  els.preset.disabled = true;
  lastBalance = undefined;
  els.delta.textContent = "";
  els.delta.className = "";

  setStatus("boot", "reading specifier, fetching bundle, verifying keccak256…");
  logStart = Date.now();
  logLine("demo", "info", `starting — specifier ${s.specifier} via ${new URL(s.bootstrap).host}`);
  const bootstrapCall = jsonRpc(fetch, s.bootstrap);
  worker = new AnonRpcWorker({
    address: s.specifier,
    config: parseConfig(s.config),
    preExisting: {
      rpcProvider: {
        request: ({ method, params }) => bootstrapCall(method, (params as unknown[]) ?? []),
      },
    },
  });

  pumpWorkerLogs(worker);

  const t0 = Date.now();
  try {
    await worker.ready;
  } catch (e) {
    // Logged as well as shown: the status line holds one message, and the
    // worker's own last lines are sitting right above this one in the drawer.
    logLine("demo", "error", `worker failed to start: ${(e as Error).message}`);
    setStatus("error", `worker failed to start: ${(e as Error).message}`);
    stop(true);
    return;
  }
  logLine("demo", "info", `worker ready in ${Date.now() - t0} ms — bundle hash verified, running in the sandbox`);
  if (!running) return; // stopped while booting

  // A worker booted through this bootstrap RPC: it has earned persistence.
  persist({ bootstrap: s.bootstrap });

  // `worker.ready` fulfilled: the hash-verified bundle is running in the
  // sandbox. tick() takes over the status from its first in-flight request.
  setStatus("ready", "worker ready — bundle verified and running in the sandbox");
  void tick(s);
  timer = window.setInterval(() => void tick(s), POLL_MS);
}

function stop(keepStatus = false): void {
  if (running) logLine("demo", "info", "stopped — worker closed");
  running = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  worker?.close();
  worker = undefined;
  els.toggle.textContent = "Start watching";
  for (const f of fields) els[f].disabled = false;
  els.copy.disabled = false;
  els.preset.disabled = false;
  if (!keepStatus) setStatus("idle", "");
}

els.toggle.addEventListener("click", () => (running ? stop() : void start()));
