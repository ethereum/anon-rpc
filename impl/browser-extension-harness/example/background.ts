// The example extension's service worker.
//
// This is what an integrating wallet writes: a pre-existing RPC provider it
// already has, an `AnonRpcWorker` constructed from it, and `worker.fetch` used
// wherever an anonymized RPC call is wanted. Everything else — the offscreen
// document, the sandboxed page, the §4 verification — is the harness's job.
//
// Note the shape of the worker's lifetime. It is NOT created at install time
// and held in a module variable that survives: MV3 kills an idle service worker
// and this whole file is re-evaluated on the next event. So the worker is
// created on demand and the module variable is a per-incarnation cache. The
// harness makes that cheap — the offscreen document still has the booted worker
// and hands the same one back.

import { AnonRpcWorker } from "@anon-rpc/browser-extension-harness";

declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        fn: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | void,
      ): void;
    };
  };
};

// Substituted at build time. These are declared as IDENTIFIERS, not written as
// "__TEST_ORIGIN__" string literals: esbuild's `define` rewrites identifier
// tokens and does not look inside strings, so the literal form silently ships
// the placeholder and fails later as a bare "Failed to fetch".
declare const __TEST_ORIGIN__: string;
declare const __SPECIFIER__: string;

/** Where the example's stub chain and resolver live; set by the test harness. */
const ORIGIN = __TEST_ORIGIN__;
const SPECIFIER = __SPECIFIER__;

/** A pre-existing RPC connection, as §4 assumes the host already has. */
const rpcProvider = {
  async request({ method, params }: { method: string; params?: unknown[] }) {
    const res = await fetch(`${ORIGIN}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  },
};

// Per-incarnation cache, keyed by specifier. Not persistence: when MV3 kills
// this service worker the map goes with it, and the next incarnation rebuilds
// it — cheaply, because the offscreen document still holds the booted worker.
const workers = new Map<string, AnonRpcWorker>();

// §13 entries collected from each worker, so the example has somewhere to put
// them and the e2e has something to read. A real extension would render these
// — the demo extension does — but the shape is the same: one pull loop per
// worker, ended by the rejection acceptLog() gives when the worker goes away.
const logs = new Map<string, { level: string; args: string[] }[]>();

function collectLogs(key: string, w: AnonRpcWorker): void {
  const rows: { level: string; args: string[] }[] = [];
  logs.set(key, rows);
  void (async () => {
    for (;;) {
      try {
        const entry = await w.acceptLog();
        rows.push({ level: entry.level, args: entry.args.map(String) });
      } catch {
        return;
      }
    }
  })();
}

function getWorker(address: string, iframeUrl?: string): AnonRpcWorker {
  const key = `${address}|${iframeUrl ?? ""}`;
  let w = workers.get(key);
  if (!w) {
    w = new AnonRpcWorker({
      address,
      preExisting: { rpcProvider },
      // Normally omitted — the harness defaults to the packaged sandbox page.
      // The e2e sets it to check §6's same-origin requirement is enforced.
      ...(iframeUrl ? { iframeUrl } : {}),
    });
    workers.set(key, w);
    collectLogs(key, w);
    // Failure is final for a worker (§7), so a cache that keeps one hands the
    // same rejection to every retry — and the usual cause of a boot failure
    // is something the caller is about to fix. Anything caching workers needs
    // this; the harness does the same for its own offscreen cache.
    const failed = w;
    void failed.ready.catch(() => {
      if (workers.get(key) === failed) workers.delete(key);
    });
  }
  return w;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const m = msg as {
    type?: string;
    body?: unknown;
    address?: string;
    url?: string;
    iframeUrl?: string;
  };
  if (m?.type === "anon-logs") {
    const key = `${m.address || SPECIFIER}|${m.iframeUrl ?? ""}`;
    respond({ ok: true, rows: logs.get(key) ?? [] });
    return true;
  }
  if (m?.type !== "anon-fetch") return;

  void (async () => {
    try {
      const w = getWorker(m.address || SPECIFIER, m.iframeUrl);
      await w.ready;
      const res = await w.fetch(m.url || `${ORIGIN}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(m.body),
      });
      respond({ ok: true, status: res.status, json: await res.json() });
    } catch (e) {
      respond({ ok: false, error: (e as Error)?.message ?? String(e) });
    }
  })();

  return true; // keep the message channel open for the async respond
});
