// Bench harness: the in-page half of the anon-rpc latency measurement.
//
// Exposes window.__bench for bench/run.mjs to drive. No UI, no polling, no
// persistence — every decision (which arms, how many samples, what order)
// belongs to the driver, so the measurement protocol lives in one readable
// file rather than being split across a page and a script.
//
// Each arm keeps a booted worker for the whole run, so bootstrap is paid once
// and measured separately from steady-state request cost. Those are different
// numbers for different questions ("what does starting cost me?" vs "what does
// each query cost me?") and averaging them together is the mistake this page
// exists to avoid.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";

type Arm = {
  /** Stable id, also the label in the driver's output. */
  id: string;
  /** IWorkerSpecifier address on mainnet; omitted for the `direct` control. */
  specifier?: string;
  /** §7.1 config handed to the worker as-is. */
  config?: unknown;
};

type BootResult = { id: string; ok: boolean; bootMs: number; error?: string };
type Sample = { id: string; ok: boolean; ms: number; error?: string; result?: string };

/** JSON-RPC over an arbitrary fetch implementation — the demo's shape. */
function jsonRpc(fetchImpl: typeof fetch, url: string) {
  let id = 0;
  return async (method: string, params: unknown[]): Promise<unknown> => {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? "RPC error");
    return body.result;
  };
}

const workers = new Map<string, AnonRpcWorker>();
const log = (s: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += `\n${s}`;
};

/**
 * Boot one arm and time it.
 *
 * The clock covers what a wallet actually waits through on first use: reading
 * the specifier from mainnet, fetching the bundle from a resolver, verifying
 * its keccak256, and running it to readiness. That is the real cold-start cost,
 * which is why the driver measures the live specifier path rather than pinning
 * a local bundle.
 */
async function boot(arm: Arm, bootstrapRpc: string): Promise<BootResult> {
  const t0 = performance.now();
  if (!arm.specifier) {
    // The `direct` control has nothing to boot; report 0 so the shape matches.
    return { id: arm.id, ok: true, bootMs: 0 };
  }
  const bootstrapCall = jsonRpc(fetch, bootstrapRpc);
  try {
    const worker = new AnonRpcWorker({
      address: arm.specifier,
      config: arm.config,
      preExisting: {
        rpcProvider: {
          request: ({ method, params }: { method: string; params?: unknown }) =>
            bootstrapCall(method, (params as unknown[]) ?? []),
        },
      },
    });
    await worker.ready;
    workers.set(arm.id, worker);
    const bootMs = performance.now() - t0;
    log(`booted ${arm.id} in ${bootMs.toFixed(0)}ms`);
    return { id: arm.id, ok: true, bootMs };
  } catch (e) {
    return {
      id: arm.id,
      ok: false,
      bootMs: performance.now() - t0,
      error: (e as Error).message,
    };
  }
}

/**
 * One eth_getBalance through one arm.
 *
 * Errors are returned rather than thrown: an unauthed RPC that rate-limits mid
 * run should cost one discarded sample, not the whole matrix. The driver counts
 * the discards and reports them, because a high discard rate is itself a result.
 */
async function sample(armId: string, rpcUrl: string, watch: string): Promise<Sample> {
  const fetchImpl = armId === "direct" ? fetch : workers.get(armId)?.fetch;
  if (!fetchImpl) return { id: armId, ok: false, ms: 0, error: "arm not booted" };
  const call = jsonRpc(fetchImpl, rpcUrl);
  const t0 = performance.now();
  try {
    const result = (await call("eth_getBalance", [watch, "latest"])) as string;
    return { id: armId, ok: true, ms: performance.now() - t0, result };
  } catch (e) {
    return { id: armId, ok: false, ms: performance.now() - t0, error: (e as Error).message };
  }
}

declare global {
  interface Window {
    __bench: {
      boot(arms: Arm[], bootstrapRpc: string): Promise<BootResult[]>;
      sample(armId: string, rpcUrl: string, watch: string): Promise<Sample>;
    };
  }
}

window.__bench = {
  // Sequential, not Promise.all: booting tor-js concurrently with anything else
  // makes both slower and neither number trustworthy.
  async boot(arms, bootstrapRpc) {
    const out: BootResult[] = [];
    for (const arm of arms) out.push(await boot(arm, bootstrapRpc));
    return out;
  },
  sample,
};

log("ready");
