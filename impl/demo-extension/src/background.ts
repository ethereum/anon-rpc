// The demo extension's service worker. This is the part a wallet would write.
//
// It owns the `AnonRpcWorker` and does every anonymized call; the popup only
// renders. That split is not decoration — it is the shape MV3 forces and the
// thing this demo exists to show:
//
//   * A popup is destroyed the moment it loses focus, so a watcher living
//     there would die with it.
//   * A service worker is destroyed after ~30s idle, so this file is
//     re-evaluated from scratch on the next message and every module variable
//     is gone.
//   * The offscreen document, where the harness actually runs, survives both.
//     So the booted worker outlives the code that asked for it, and a reopened
//     popup reattaches to a worker that is already verified and running.
//
// `providerCalls` below is how the UI can tell the difference honestly: §4's
// specifier read goes through the provider in THIS file, so if the provider was
// called, the bundle was re-fetched and re-verified. If it was not, the
// offscreen document handed back the worker it already had.

import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        fn: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | void,
      ): void;
    };
  };
  storage: {
    local: { get(k: null | string | string[]): Promise<Record<string, unknown>>; set(v: object): Promise<void> };
    session: { get(k: null | string | string[]): Promise<Record<string, unknown>>; set(v: object): Promise<void> };
  };
};

export type Settings = {
  bootstrap: string;
  workerRpc: string;
  specifier: string;
  config: string;
  watch: string;
  preset?: string;
};

type Runtime = {
  running: boolean;
  /** Wall-clock ms the last boot took, and whether it was a cold one. */
  bootMs?: number;
  cold?: boolean;
  lastBalance?: string; // decimal string: bigint is not JSON
};

/**
 * Two stores, because "what the user typed" and "what is known to work" are
 * different things.
 *
 * `local` is the durable prefill for the next popup, and an RPC URL only
 * reaches it once it has actually served — a bootstrap URL when a worker boots
 * through it, a worker URL when a balance query comes back. Saving them on
 * `start` instead would make a typo the sticky default, which is precisely the
 * state that is most annoying to get out of.
 *
 * `session` holds the settings currently in use, so `poll` can find the
 * unproven URLs it is mid-way through proving, and so a reopened popup shows
 * what is actually running rather than the last thing that worked.
 */
const SAVED_KEY = "settings";
const ACTIVE_KEY = "active";
const RUNTIME_KEY = "runtime";
const LOGS_KEY = "logs";

const loadSaved = async (): Promise<Partial<Settings>> =>
  ((await chrome.storage.local.get(SAVED_KEY))[SAVED_KEY] as Partial<Settings>) ?? {};
const mergeSaved = async (patch: Partial<Settings>): Promise<void> =>
  chrome.storage.local.set({ [SAVED_KEY]: { ...(await loadSaved()), ...patch } });

const loadActive = async (): Promise<Partial<Settings>> =>
  ((await chrome.storage.session.get(ACTIVE_KEY))[ACTIVE_KEY] as Partial<Settings>) ?? {};
const saveActive = (s: Settings): Promise<void> => chrome.storage.session.set({ [ACTIVE_KEY]: s });

const loadRuntime = async (): Promise<Runtime> =>
  ((await chrome.storage.session.get(RUNTIME_KEY))[RUNTIME_KEY] as Runtime) ?? { running: false };
const saveRuntime = (r: Runtime): Promise<void> => chrome.storage.session.set({ [RUNTIME_KEY]: r });

/* --- §13 log buffer ------------------------------------------------------
   The popup cannot hold this. It is destroyed the moment it loses focus, and
   the worker keeps running without it — so a log kept in the popup would show
   only what happened while you were looking at it, which is the opposite of
   what a log is for.

   So the service worker collects, and `chrome.storage.session` holds the
   result: it survives the popup closing AND this service worker being killed
   for idleness, while still being cleared when the browser restarts, which is
   the right lifetime for diagnostics. */

export type LogRow = {
  at: number;
  src: "demo" | "worker";
  level: "debug" | "info" | "warn" | "error";
  msg: string;
};

/** Rows retained for the popup. The harness retains its own (§13.1). */
const LOG_ROWS = 300;

// Appends are serialised through this chain. Two concurrent read-modify-write
// cycles against the same key would silently lose whichever wrote first, and
// a log that drops lines under load is worse than no log.
let logTail: Promise<unknown> = Promise.resolve();

const loadLogs = async (): Promise<LogRow[]> =>
  ((await chrome.storage.session.get(LOGS_KEY))[LOGS_KEY] as LogRow[]) ?? [];

function appendLog(src: LogRow["src"], level: LogRow["level"], msg: string): Promise<void> {
  logTail = logTail.then(async () => {
    const rows = await loadLogs();
    rows.push({ at: Date.now(), src, level, msg });
    await chrome.storage.session.set({ [LOGS_KEY]: rows.slice(-LOG_ROWS) });
  });
  return logTail as Promise<void>;
}

/** A §13 LogArg as one readable token. Bytes are described, not transcribed. */
function renderLogArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Uint8Array) return `<${a.byteLength} bytes>`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
}

/**
 * Drain a worker's §13 entries into the buffer until it closes.
 *
 * Started once per worker per service-worker incarnation. The loop ends on
 * its own: `acceptLog` rejects when the worker fails or is closed, after
 * yielding what it still held, so the lines explaining a failure land in the
 * buffer first. A superseded worker is closed by ensureWorker, which is what
 * retires its pump — no separate bookkeeping.
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
      void appendLog("worker", entry.level, entry.args.map(renderLogArg).join(" "));
    }
  })();
}

/** Per-incarnation. A new service worker starts with nothing here. */
let worker: AnonRpcWorker | undefined;
let workerKey: string | undefined;

/** Bumped by the provider below, so a cold boot is observed rather than timed. */
let providerCalls = 0;

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

/**
 * The worker for these settings, booting it if this incarnation has none.
 *
 * Called on every poll rather than once at start: the service worker this ran
 * in may have been killed since, and a wallet has to cope with that. The
 * harness makes it cheap — see the note at the top of the file.
 */
async function ensureWorker(s: Settings): Promise<{ worker: AnonRpcWorker; bootMs: number; cold: boolean }> {
  const key = `${s.specifier.toLowerCase()}|${s.config}`;
  if (worker && workerKey === key) return { worker, bootMs: 0, cold: false };

  worker?.close();
  const bootstrapCall = jsonRpc(fetch, s.bootstrap);
  const before = providerCalls;
  const t0 = Date.now();

  const w = new AnonRpcWorker({
    address: s.specifier,
    config: parseConfig(s.config),
    preExisting: {
      rpcProvider: {
        request: ({ method, params }) => {
          providerCalls++;
          return bootstrapCall(method, (params as unknown[]) ?? []);
        },
      },
    },
  });
  // Pumped BEFORE awaiting ready: a worker that fails during boot has usually
  // said why, and those entries are exactly the ones worth keeping. Note that
  // this does NOT cache `w` yet — a worker whose ready rejects must not become
  // the cached one, or every retry returns the original failure.
  pumpWorkerLogs(w);
  await w.ready;

  worker = w;
  workerKey = key;

  // A worker booted through this bootstrap URL: it has earned persistence.
  await mergeSaved({ bootstrap: s.bootstrap });
  // §4's specifier read goes through the provider above. If it never fired,
  // nothing was re-read, re-fetched or re-verified — the offscreen document
  // returned a worker it already had booted.
  const bootMs = Date.now() - t0;
  const cold = providerCalls > before;
  void appendLog(
    "demo",
    "info",
    cold
      ? `cold boot in ${bootMs} ms — specifier read, bundle fetched, keccak256 verified`
      : `warm boot in ${bootMs} ms — reattached to the worker already running offscreen`,
  );
  return { worker: w, bootMs, cold };
}

/**
 * Worker config (§7.1) as the popup's textarea holds it. Opaque to the demo:
 * the field is worker-defined and the harness passes it through untouched, so
 * JSON validity is all that is checked. Blank means no config at all, not `{}`.
 */
function parseConfig(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`config must be valid JSON: ${(e as Error).message}`);
  }
}

function validate(s: Partial<Settings>): Settings {
  const isUrl = (u?: string) => !!u && /^https?:\/\//.test(u);
  const isAddr = (a?: string) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isUrl(s.bootstrap)) throw new Error("bootstrap RPC URL must be http(s)");
  if (!isUrl(s.workerRpc)) throw new Error("worker RPC URL must be http(s)");
  if (!isAddr(s.specifier)) throw new Error("specifier must be a 0x… address");
  if (!isAddr(s.watch)) throw new Error("watch address must be a 0x… address");
  parseConfig(s.config ?? ""); // called for its throw
  return s as Settings;
}

type Request =
  | { type: "status" }
  /** Everything the log buffer holds; the popup renders the whole window. */
  | { type: "logs" }
  | { type: "clearLogs" }
  /** Remember the fields that are not RPC URLs, as typed. */
  | { type: "save"; settings: Partial<Settings> }
  | { type: "start"; settings: Settings }
  | { type: "poll" }
  | { type: "stop" };

/**
 * The fields that persist as typed. The two RPC URLs are deliberately absent:
 * they persist only once they have served (see the store comment above).
 */
const TYPED_FIELDS = ["specifier", "config", "watch", "preset"] as const;

function typedOnly(s: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const f of TYPED_FIELDS) if (s[f] !== undefined) out[f] = s[f];
  return out;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "status": {
      const [saved, active, runtime] = await Promise.all([loadSaved(), loadActive(), loadRuntime()]);
      // What is running wins over what last worked: a reopened popup should
      // show the configuration in force, not a stale prefill.
      return { ok: true, settings: runtime.running ? { ...saved, ...active } : saved, runtime };
    }

    case "save":
      await mergeSaved(typedOnly(req.settings));
      return { ok: true };

    case "logs":
      return { ok: true, rows: await loadLogs() };

    case "clearLogs":
      await chrome.storage.session.set({ [LOGS_KEY]: [] });
      return { ok: true };

    case "start": {
      const s = validate(req.settings);
      await mergeSaved(typedOnly(s));
      await saveActive(s);
      await saveRuntime({ running: true });
      await appendLog("demo", "info", `starting — specifier ${s.specifier} via ${new URL(s.bootstrap).host}`);
      try {
        const { bootMs, cold } = await ensureWorker(s);
        const runtime: Runtime = { running: true, bootMs, cold };
        await saveRuntime(runtime);
        return { ok: true, runtime };
      } catch (e) {
        void appendLog("demo", "error", `start failed: ${(e as Error)?.message ?? String(e)}`);
        // A start that failed must not leave the session marked as running:
        // the next popup would read that and resume polling a worker which
        // never booted, reporting RPC errors forever.
        await saveRuntime({ running: false });
        throw e;
      }
    }

    case "poll": {
      const rt = await loadRuntime();
      if (!rt.running) return { ok: false, error: "not running" };
      const s = validate(await loadActive());
      const t0 = Date.now();
      const { worker: w, bootMs, cold } = await ensureWorker(s);
      const call = jsonRpc(w.fetch, s.workerRpc);
      const result = (await call("eth_getBalance", [s.watch, "latest"])) as string;
      const wei = BigInt(result).toString();
      // The worker RPC answered a real query: it has earned persistence.
      await mergeSaved({ workerRpc: s.workerRpc });
      void appendLog("demo", "info", `eth_getBalance OK in ${Date.now() - t0} ms — ${wei} wei`);
      const runtime: Runtime = {
        running: true,
        lastBalance: wei,
        // Reported only when this poll had to boot, so the popup can say so.
        ...(bootMs ? { bootMs, cold } : {}),
      };
      await saveRuntime(runtime);
      return { ok: true, balance: wei, ms: Date.now() - t0, booted: bootMs ? { bootMs, cold } : undefined };
    }

    case "stop": {
      void appendLog("demo", "info", "stopped — worker closed");
      worker?.close();
      worker = undefined;
      workerKey = undefined;
      await saveRuntime({ running: false });
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const req = msg as Request;
  if (!req?.type) return;
  void handle(req).then(
    (r) => respond(r),
    (e) => respond({ ok: false, error: (e as Error)?.message ?? String(e) }),
  );
  return true; // keep the channel open for the async respond
});
