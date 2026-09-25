// The balance-watcher demo: boots the anon-rpc browser harness against a
// user-supplied specifier contract and polls an address's ETH balance through
// the sandboxed worker's anonymized fetch.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { keccak_256 } from "@noble/hashes/sha3";
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
  {
    id: "local",
    label: "Local file — drop a bundle on this page",
    specifier: "",
    config: "",
    note: "Drag a .js worker bundle anywhere onto this page. Nothing needs publishing: the page pins its hash and builds the specifier itself.",
  },
];

const CUSTOM = PRESETS.find((p) => p.id === "custom")!;
const LOCAL = PRESETS.find((p) => p.id === "local")!;

/* --- running a worker that was never published ---------------------------
   Drop a bundle on the page and it runs, under exactly the §4 rules a
   published one runs under — because the page builds a specifier for it
   rather than skipping the specifier.

   The chain's job in §4 is to say "these bytes, by this hash, are the worker".
   Nothing says a host cannot answer that question itself when it already has
   the bytes: §4 makes the hash the identity and `workerResolvers()` advisory,
   and §4.1 lists `blob:` precisely so a locally built specifier has somewhere
   to point. So the page hashes the dropped file, serves it from a blob: URL,
   and answers the two specifier reads from memory.

   What this is NOT is a way around verification. The harness re-hashes the
   bytes it fetches and compares them with the hash this provider gave it —
   the same code path, the same comparison, no special case. Tamper with the
   blob between drop and boot and the boot fails. */

type LocalWorker = {
  name: string;
  bytes: Uint8Array;
  /** keccak256 of the bytes: the §4 identity, computed here instead of read. */
  hash: string;
  /** A §4.1 resolver entry this page can serve. Revoked when superseded. */
  url: string;
  /** Synthetic specifier address, derived from the hash — see below. */
  address: string;
};

let localWorker: LocalWorker | undefined;

/** Whether the next start should run the dropped file rather than a chain one. */
const usingLocalWorker = (): boolean =>
  !!localWorker && els.preset.value === "local" && els.specifier.value.trim() === localWorker.address;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig: string) => "0x" + toHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);

/**
 * A specifier address for a worker that has none.
 *
 * Taken from the bundle hash, so it is stable for the same bytes and distinct
 * for different bytes. That matters beyond tidiness: §11 storage is namespaced
 * per specifier address, so two dropped workers get two storage namespaces,
 * and re-dropping the same file returns to the one it had.
 */
const localAddress = (hash: string) => "0x" + hash.slice(2, 42);

/** ABI-encode `string[]` as eth_call return data. */
function encodeStringArray(strings: string[]): string {
  const word = (n: number) => n.toString(16).padStart(64, "0");
  let offsets = "";
  let bodies = "";
  let cursor = strings.length * 32;
  for (const str of strings) {
    offsets += word(cursor);
    const b = new TextEncoder().encode(str);
    const padded = Math.ceil(b.length / 32) * 32;
    bodies += word(b.length) + toHex(b).padEnd(padded * 2, "0");
    cursor += 32 + padded;
  }
  return "0x" + word(32) + word(strings.length) + offsets + bodies;
}

/**
 * The §4 half of an `IWorkerSpecifier`, answered from memory.
 *
 * Only `eth_call` to this worker's own address is handled; anything else
 * throws rather than being forwarded, so a local run cannot quietly depend on
 * a chain connection it is supposed to be doing without.
 */
function localProvider(local: LocalWorker) {
  const HASH = selector("workerHash()");
  const RESOLVERS = selector("workerResolvers()");
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const call = (params as [{ to?: string; data?: string }] | undefined)?.[0];
      if (method !== "eth_call" || call?.to?.toLowerCase() !== local.address.toLowerCase()) {
        throw new Error(`local worker: no chain to answer ${method}`);
      }
      const sel = (call.data ?? "").slice(0, 10);
      if (sel === HASH) return local.hash;
      if (sel === RESOLVERS) return encodeStringArray([local.url]);
      throw new Error(`local worker: unexpected specifier call ${sel}`);
    },
  };
}
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
  dropVeil: $<HTMLDivElement>("drop-veil"),
  confirmVeil: $<HTMLDivElement>("confirm-veil"),
  confirmName: $<HTMLElement>("confirm-name"),
  confirmSize: $<HTMLElement>("confirm-size"),
  confirmHash: $<HTMLElement>("confirm-hash"),
  confirmCancel: $<HTMLButtonElement>("confirm-cancel"),
  confirmRun: $<HTMLButtonElement>("confirm-run"),
};

/* --- the drop flow -------------------------------------------------------
   Dragging anything over the page raises a target; dropping a file hashes it
   and asks. Accepting is a separate click because accepting means running
   someone's code — the sandbox makes that safe for this page, not safe in
   general. */

/** The file waiting on a decision. Cleared whichever way the answer goes. */
let pending: { name: string; bytes: Uint8Array; hash: string } | undefined;

let dragDepth = 0; // dragenter/dragleave fire per child; count rather than toggle

function showDropTarget(on: boolean): void {
  els.dropVeil.hidden = !on;
}

window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  showDropTarget(true);
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    showDropTarget(false);
  }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); // or the browser navigates
});
window.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  e.preventDefault(); // otherwise the browser opens the file and loses the page
  dragDepth = 0;
  showDropTarget(false);
  void offerFile(file);
});

async function offerFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) {
    setStatus("error", `${file.name} is empty`);
    return;
  }
  pending = { name: file.name, bytes, hash: "0x" + toHex(keccak_256(bytes)) };
  els.confirmName.textContent = file.name;
  els.confirmSize.textContent = `${bytes.length.toLocaleString("en-US")} bytes`;
  els.confirmHash.textContent = pending.hash;
  els.confirmVeil.hidden = false;
  els.confirmRun.focus();
}

function dismissConfirm(): void {
  pending = undefined;
  els.confirmVeil.hidden = true;
}

els.confirmCancel.addEventListener("click", dismissConfirm);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.confirmVeil.hidden) dismissConfirm();
});

els.confirmRun.addEventListener("click", () => {
  if (!pending) return;
  const { name, bytes, hash } = pending;
  dismissConfirm();

  // Whatever was running belongs to the previous choice.
  if (running) stop();
  // Revoking the old URL matters: a blob: URL pins its bytes in memory for
  // the life of the document, so dropping ten files would hold ten bundles.
  if (localWorker) URL.revokeObjectURL(localWorker.url);

  localWorker = {
    name,
    bytes,
    hash,
    url: URL.createObjectURL(new Blob([bytes as BufferSource], { type: "text/javascript" })),
    address: localAddress(hash),
  };

  els.preset.value = LOCAL.id;
  els.specifier.value = localWorker.address;
  renderPreset(LOCAL);
  setStatus("idle", `${name} ready — press Start watching`);
});

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
  if (p.id === LOCAL.id && localWorker) {
    // The file IS the note: nothing published says what this worker is, so
    // the page shows the two things that identify it.
    els.presetNote.className = "field-note local-note";
    els.presetNote.textContent = "";
    els.presetNote.append(
      `${localWorker.name} — ${localWorker.bytes.length.toLocaleString("en-US")} bytes, pinned to `,
    );
    const h = document.createElement("span");
    h.className = "hash";
    h.textContent = localWorker.hash;
    els.presetNote.append(h);
    els.configNote.textContent = p.configNote ?? "";
    return;
  }
  els.presetNote.className = "field-note";
  els.presetNote.textContent = p.note ?? "";
  // Only a caveat about the example config, if the entry carries one; the
  // generic "what this field is" hint is static in the markup.
  els.configNote.textContent = p.configNote ?? "";
}

/** Adopt a preset: fill the fields it prescribes, then re-render. */
function applyPreset(p: Preset): void {
  if (p.id === LOCAL.id) {
    // Nothing to prefill: the dropped file supplies both, and picking this
    // entry with no file is an invitation to drop one.
    els.specifier.value = localWorker?.address ?? "";
    persist({ preset: p.id });
    renderPreset(p);
    return;
  }
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
  if (els.preset.value === LOCAL.id && !localWorker) {
    throw new Error("drop a .js worker bundle onto this page first");
  }
  if (usingLocalWorker()) {
    // No bootstrap RPC is needed or wanted: §4's two reads are answered from
    // memory, so a local run touches no chain at all. Demanding a URL it
    // would never call would be theatre.
    if (!isUrl(s.workerRpc)) throw new Error("worker RPC URL must be http(s)");
    if (!isAddr(s.watch)) throw new Error("watch address must be a 0x… address");
    parseConfig(s.config);
    return s;
  }
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

  const local = usingLocalWorker() ? localWorker : undefined;
  setStatus(
    "boot",
    local ? "verifying keccak256 of the dropped file…" : "reading specifier, fetching bundle, verifying keccak256…",
  );
  logStart = Date.now();
  logLine(
    "demo",
    "info",
    local
      ? `starting ${local.name} — local specifier ${local.address}, pinned to ${local.hash}`
      : `starting — specifier ${s.specifier} via ${new URL(s.bootstrap).host}`,
  );

  const bootstrapCall = local ? undefined : jsonRpc(fetch, s.bootstrap);
  worker = new AnonRpcWorker({
    address: local ? local.address : s.specifier,
    config: parseConfig(s.config),
    preExisting: {
      rpcProvider: local
        ? localProvider(local)
        : {
            request: ({ method, params }) => bootstrapCall!(method, (params as unknown[]) ?? []),
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
  // A local run used none, so there is nothing to have earned it.
  if (!local) persist({ bootstrap: s.bootstrap });

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
