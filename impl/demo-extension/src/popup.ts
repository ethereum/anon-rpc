// The popup's script. Renders and forwards; it never constructs a worker.
//
// Two things about a popup shape this file. It is destroyed whenever it loses
// focus, so it cannot hold state — every reopen asks the service worker what is
// actually going on. And it is the only thing with a timer, so it drives the
// poll cadence while it is open and stops driving it when it closes, while the
// worker itself stays booted in the offscreen document.

import { PRESETS, type Preset } from "./presets.js";

declare const chrome: {
  runtime: { sendMessage(msg: unknown): Promise<unknown> };
};

const POLL_MS = 12_000; // ~mainnet block time
const DEFAULT_WATCH = "0x00000000219ab540356cBB839Cbe05303d7705Fa"; // beacon deposit contract

// Probed in order on first use to prefill the RPC fields, same list and same
// order as the web demo. All mainnet; the web demo also needs them CORS-open,
// which this does not — the popup fetches under the extension's host
// permissions. Availability shifts, hence a probe rather than a hardcoded one.
const PUBLIC_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
];

type Settings = {
  bootstrap: string;
  workerRpc: string;
  specifier: string;
  config: string;
  watch: string;
  preset?: string;
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const els = {
  preset: $<HTMLSelectElement>("preset"),
  presetNote: $<HTMLParagraphElement>("preset-note"),
  specifier: $<HTMLInputElement>("specifier"),
  config: $<HTMLTextAreaElement>("config"),
  configNote: $<HTMLParagraphElement>("config-note"),
  bootstrap: $<HTMLInputElement>("bootstrap"),
  workerRpc: $<HTMLInputElement>("worker-rpc"),
  copy: $<HTMLButtonElement>("copy"),
  watch: $<HTMLInputElement>("watch"),
  toggle: $<HTMLButtonElement>("toggle"),
  pill: $<HTMLSpanElement>("pill"),
  detail: $<HTMLParagraphElement>("detail"),
  balanceCard: $<HTMLElement>("balance-card"),
  balance: $<HTMLDivElement>("balance"),
  delta: $<HTMLDivElement>("delta"),
  checked: $<HTMLDivElement>("checked"),
  bootNote: $<HTMLSpanElement>("boot-note"),
};

const fields = ["bootstrap", "workerRpc", "specifier", "config", "watch"] as const;

const send = <T>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

/**
 * Remember the typed fields, coalesced.
 *
 * The web demo writes to localStorage synchronously on every keystroke; this
 * has to cross to the service worker, so it waits for a pause instead. The two
 * RPC URLs are not sent at all — the service worker persists those only once
 * they have served.
 */
let saveTimer: number | undefined;
function saveTyped(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void send({
      type: "save",
      settings: {
        specifier: els.specifier.value.trim(),
        config: els.config.value,
        watch: els.watch.value.trim(),
        preset: els.preset.value,
      },
    });
  }, 300);
}

/**
 * Fill the RPC fields from the first public endpoint that answers as mainnet.
 *
 * Only ever runs when nothing is saved, and never overwrites a field the user
 * has already typed into — the probe is slower than a person is, so it can
 * finish after they have started.
 */
async function prefillRpcs(): Promise<void> {
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
        // endpoint down, slow, or not answering as mainnet: try the next
      }
    }
  } finally {
    els.bootstrap.placeholder = restore;
  }
}

/* --- presets ------------------------------------------------------------ */

const CUSTOM = PRESETS[PRESETS.length - 1];
const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? CUSTOM;
const presetBySpecifier = (addr: string): Preset | undefined =>
  PRESETS.find((p) => p.specifier && p.specifier.toLowerCase() === addr.toLowerCase());

for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  els.preset.append(opt);
}

function renderPreset(p: Preset): void {
  els.presetNote.textContent = p.note ?? "";
  els.configNote.textContent = p.configNote ?? "";
}

function applyPreset(p: Preset): void {
  if (p.specifier) els.specifier.value = p.specifier;
  // Always assigned, blank included: switching worker must not leave the
  // previous one's config behind for this one to be started with.
  els.config.value = p.config;
  renderPreset(p);
  saveTyped();
}

/* --- status ------------------------------------------------------------- */

type State = "idle" | "boot" | "ready" | "live" | "error";

function setStatus(state: State, detail: string): void {
  els.pill.className = `pill ${state === "idle" ? "" : state}`;
  els.pill.textContent =
    { idle: "idle", boot: "starting", ready: "ready", live: "watching", error: "error" }[state];
  els.detail.textContent = detail;
}

const WEI = 10n ** 18n;

function formatEth(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = (abs / WEI).toLocaleString("en-US");
  const frac = (abs % WEI).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}

/* --- the watcher -------------------------------------------------------- */

let timer: number | undefined;
let running = false;
let lastBalance: bigint | undefined;

function setControlsDisabled(disabled: boolean): void {
  for (const f of fields) els[f].disabled = disabled;
  els.preset.disabled = disabled;
  els.copy.disabled = disabled;
}

function showBalance(wei: bigint): void {
  els.balanceCard.hidden = false;
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
}

/** Say whether the last boot re-verified the bundle or reused a live worker. */
function noteBoot(booted?: { bootMs: number; cold: boolean }): void {
  if (!booted) return;
  els.bootNote.textContent = booted.cold
    ? `cold boot in ${booted.bootMs} ms — specifier read, bundle fetched, keccak256 verified`
    : `warm boot in ${booted.bootMs} ms — reattached to the worker already running offscreen`;
}

async function poll(): Promise<void> {
  if (!running) return;
  const t0 = Date.now();
  setStatus(lastBalance === undefined ? "ready" : "live", "eth_getBalance in flight through the worker…");
  const res = await send<{ ok: boolean; balance?: string; ms?: number; error?: string; booted?: { bootMs: number; cold: boolean } }>(
    { type: "poll" },
  );
  if (!running) return; // closed or stopped while in flight
  if (!res.ok) {
    // Keep polling: a transient RPC failure should not stop the watcher.
    setStatus("error", `${res.error} — retrying in ${POLL_MS / 1000} s`);
    return;
  }
  noteBoot(res.booted);
  showBalance(BigInt(res.balance!));
  setStatus("live", `request OK in ${res.ms} ms — next poll in ${POLL_MS / 1000} s`);
}

function beginPolling(): void {
  running = true;
  els.toggle.textContent = "Stop";
  setControlsDisabled(true);
  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);
}

async function start(): Promise<void> {
  const settings = Object.fromEntries(
    fields.map((f) => [f, els[f].value.trim()]),
  ) as unknown as Settings;
  settings.preset = els.preset.value;

  setStatus("boot", "reading specifier, fetching bundle, verifying keccak256…");
  els.toggle.disabled = true;
  const res = await send<{ ok: boolean; error?: string; runtime?: { bootMs: number; cold: boolean } }>({
    type: "start",
    settings,
  });
  els.toggle.disabled = false;
  if (!res.ok) {
    setStatus("error", res.error ?? "could not start");
    return;
  }
  noteBoot(res.runtime);
  beginPolling();
}

async function stop(): Promise<void> {
  running = false;
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  els.toggle.textContent = "Start watching";
  setControlsDisabled(false);
  els.bootNote.textContent = "";
  setStatus("idle", "");
  await send({ type: "stop" });
}

els.toggle.addEventListener("click", () => void (running ? stop() : start()));
els.copy.addEventListener("click", () => {
  els.workerRpc.value = els.bootstrap.value;
});
els.specifier.addEventListener("input", () => {
  // Hand-editing away from a preset's address is a switch to custom.
  const match = presetBySpecifier(els.specifier.value.trim()) ?? CUSTOM;
  if (match.id !== els.preset.value) {
    els.preset.value = match.id;
    renderPreset(match);
  }
  saveTyped();
});
els.config.addEventListener("input", saveTyped);
els.watch.addEventListener("input", saveTyped);
els.preset.addEventListener("change", () => applyPreset(presetById(els.preset.value)));

/* --- boot the popup ----------------------------------------------------- */

// The service worker is the source of truth. A popup that assumed "idle" on
// open would show the wrong thing every time it was reopened mid-watch, which
// is the normal case for a background watcher.
void (async () => {
  const { settings = {}, runtime = { running: false } } = await send<{
    settings: Partial<Settings>;
    runtime: { running: boolean; lastBalance?: string; bootMs?: number; cold?: boolean };
  }>({ type: "status" });

  for (const f of fields) els[f].value = settings[f] ?? "";
  if (!els.watch.value) els.watch.value = DEFAULT_WATCH;

  const initial = els.specifier.value
    ? (presetBySpecifier(els.specifier.value) ?? CUSTOM)
    : presetById(settings.preset ?? PRESETS[0].id);
  els.preset.value = initial.id;
  if (els.specifier.value) renderPreset(initial);
  else applyPreset(initial);

  // Nothing proven yet: find an endpoint that works rather than leaving the
  // two RPC fields blank for the reader to fill in by hand.
  if (!els.bootstrap.value || !els.workerRpc.value) void prefillRpcs();

  if (runtime.lastBalance) {
    // Shown before the first poll of this popup so a reopen is not blank; the
    // delta baseline is set here so the next change reads against what the
    // user last saw.
    showBalance(BigInt(runtime.lastBalance));
    els.checked.textContent = "last checked in an earlier popup session";
  }
  if (runtime.running) {
    noteBoot(runtime.bootMs === undefined ? undefined : { bootMs: runtime.bootMs, cold: !!runtime.cold });
    beginPolling();
  }
})();
