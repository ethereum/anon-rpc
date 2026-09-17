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
// `coldBoots` below is how the UI can tell the difference honestly: §4's
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
  error?: string;
};

const SETTINGS_KEY = "settings";
const RUNTIME_KEY = "runtime";

/** Settings live across browser restarts; runtime state only for the session. */
const loadSettings = async (): Promise<Partial<Settings>> =>
  ((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings>) ?? {};
const saveSettings = (s: Settings) => chrome.storage.local.set({ [SETTINGS_KEY]: s });
const loadRuntime = async (): Promise<Runtime> =>
  ((await chrome.storage.session.get(RUNTIME_KEY))[RUNTIME_KEY] as Runtime) ?? { running: false };
const saveRuntime = (r: Runtime) => chrome.storage.session.set({ [RUNTIME_KEY]: r });

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
  await w.ready;

  worker = w;
  workerKey = key;
  // §4's specifier read goes through the provider above. If it never fired,
  // nothing was re-read, re-fetched or re-verified — the offscreen document
  // returned a worker it already had booted.
  return { worker: w, bootMs: Date.now() - t0, cold: providerCalls > before };
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
  | { type: "start"; settings: Settings }
  | { type: "poll" }
  | { type: "stop" };

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "status":
      return { ok: true, settings: await loadSettings(), runtime: await loadRuntime() };

    case "start": {
      const s = validate(req.settings);
      await saveSettings(s);
      await saveRuntime({ running: true });
      const { bootMs, cold } = await ensureWorker(s);
      const runtime: Runtime = { running: true, bootMs, cold };
      await saveRuntime(runtime);
      return { ok: true, runtime };
    }

    case "poll": {
      const rt = await loadRuntime();
      if (!rt.running) return { ok: false, error: "not running" };
      const s = validate(await loadSettings());
      const t0 = Date.now();
      const { worker: w, bootMs, cold } = await ensureWorker(s);
      const call = jsonRpc(w.fetch, s.workerRpc);
      const result = (await call("eth_getBalance", [s.watch, "latest"])) as string;
      const wei = BigInt(result).toString();
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
