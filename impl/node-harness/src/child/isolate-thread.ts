// Runs on a worker_thread and owns the QuickJS isolate.
//
// Why a thread at all, when the isolate is already the boundary: the sync
// QuickJS variant runs guest code on the calling thread, and the isolate's
// interrupt deadline is measured in seconds. In-process that means a guest
// could block the host's event loop for as long as its deadline allows —
// unacceptable for a wallet, and nothing to do with whether the guest can
// escape (it cannot). So the thread is about liveness, not containment.
//
// It buys two things beyond that, both cheap:
//   * `worker.terminate()` is a hard stop that needs no cooperation.
//   * Anything that does manage to crash the runtime — a QuickJS bug, a stack
//     budget that turns out to be too generous for some shape we did not
//     probe — takes this thread down and surfaces to the host as a worker
//     failure, rather than taking the host with it.
//
// This file holds NO authority the isolate does not: it forwards. The one
// exception is `timer`, answered locally because a delay is not a capability
// and a round trip to the host for every setTimeout would be silly.

import { parentPort, workerData } from "node:worker_threads";
import { webcrypto } from "node:crypto";
import { Isolate, type IsolateCapabilities } from "./isolate.js";
import { Rpc, type PortLike } from "../protocol.js";

if (!parentPort) throw new Error("isolate-thread must be run as a worker_thread");
const port = parentPort;

/** What crosses the thread boundary: the guest's JSON args plus its bytes. */
export type GuestPayload = { args: unknown; bytes?: Uint8Array };
export type GuestReply = { value?: unknown; bytes?: Uint8Array };

const rpc = new Rpc({
  postMessage: (msg) => port.postMessage(msg),
  setOnMessage: (fn) => port.on("message", (m) => fn(m)),
} satisfies PortLike);

/** Guest events the host handles; anything else from the guest is a bug. */
const FORWARDED_EVENTS = new Set([
  "log",
  "worker.ready",
  "worker.failed",
  "call.respond",
  "call.fail",
  "socket.end",
  "socket.close",
]);

/** Guest requests the host answers. */
const FORWARDED_REQUESTS = new Set([
  "call.accept",
  "fetch",
  "socket.connect",
  "socket.read",
  "socket.write",
  "socket.closed",
]);

let isolate: Isolate | undefined;
const timers = new Map<number, NodeJS.Timeout>();
/**
 * Abort controllers for guest `acceptCall`s that passed a signal.
 *
 * The guest cannot send an AbortSignal — only JSON and bytes cross — so it
 * sends a sequence number with the accept and a `call.accept.abort` event
 * carrying the same number. Mapping that back onto the Rpc call's signal is
 * what lets the host withdraw the parked taker from its queue (§8) instead of
 * holding one for a guest that stopped waiting.
 */
const accepts = new Map<number, AbortController>();

/** Every path that ends the thread goes through here, so the isolate is freed. */
function shutdown(code: number): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  isolate?.dispose();
  isolate = undefined;
  process.exit(code);
}

rpc.onEvent(
  "init",
  (init: {
    bundle: Uint8Array;
    config: unknown;
    address: string;
    capabilities: IsolateCapabilities;
    limits?: { memoryBytes?: number; deadlineMs?: number };
  }) => {
    void boot(init).catch((e) => {
      fail((e as Error)?.message ?? String(e));
    });
  },
);

/**
 * Report a harness-side failure to the host, in the same envelope the guest's
 * own events use so the host unwraps one shape rather than two.
 */
function fail(message: string): void {
  rpc.emit("worker.failed", { args: { code: "internal-error", message } } satisfies GuestPayload);
}

async function boot(init: {
  bundle: Uint8Array;
  config: unknown;
  address: string;
  capabilities: IsolateCapabilities;
  limits?: { memoryBytes?: number; deadlineMs?: number };
}): Promise<void> {
  isolate = await Isolate.create(init.capabilities, init.config, {
    memoryBytes: init.limits?.memoryBytes,
    deadlineMs: init.limits?.deadlineMs,

    onRequest: async (method, args, bytes) => {
      // A delay is not authority, so it is answered here rather than being a
      // round trip. Cancellation matters: a guest that sets and clears many
      // timers must not leave this thread holding them.
      if (method === "timer") {
        const { id, ms } = (args ?? {}) as { id: number; ms: number };
        await new Promise<void>((res) => {
          const t = setTimeout(() => {
            timers.delete(id);
            res();
          }, Math.min(Math.max(0, ms), 2 ** 31 - 1));
          timers.set(id, t);
        });
        return {};
      }
      if (!FORWARDED_REQUESTS.has(method)) {
        throw Object.assign(new Error(`no such capability: ${method}`), { code: "unsupported" });
      }

      // An accept carries a seq so the guest's abort can reach this call's
      // signal, and through it the host's queue.
      let ac: AbortController | undefined;
      let seq: number | undefined;
      if (method === "call.accept") {
        seq = (args as { seq?: number })?.seq;
        if (typeof seq === "number") {
          ac = new AbortController();
          accepts.set(seq, ac);
        }
      }
      try {
        const reply =
          (await rpc.call<GuestReply>(method, { args, bytes } satisfies GuestPayload, {
            signal: ac?.signal,
          })) ?? {};
        return { value: reply.value, bytes: reply.bytes };
      } finally {
        if (seq !== undefined) accepts.delete(seq);
      }
    },

    onSend: (method, args, bytes) => {
      if (method === "timer.cancel") {
        const { id } = (args ?? {}) as { id: number };
        const t = timers.get(id);
        if (t) {
          clearTimeout(t);
          timers.delete(id);
        }
        return;
      }
      if (method === "call.accept.abort") {
        const { seq } = (args ?? {}) as { seq?: number };
        if (typeof seq === "number") accepts.get(seq)?.abort();
        return;
      }
      if (!FORWARDED_EVENTS.has(method)) return; // a guest cannot invent topics
      rpc.emit(method, { args, bytes } satisfies GuestPayload);
    },

    random: (n) => webcrypto.getRandomValues(new Uint8Array(n)),

    // Failures with no guest frame to throw into: an unhandled guest rejection,
    // an interrupted job. §12 calls worker failure unrecoverable, so they are
    // reported as such rather than swallowed.
    onInternalError: (e) => fail((e as Error)?.message ?? String(e)),
  });

  // The bundle arrives as the BYTES the host hash-verified (§4), never a path,
  // so there is no file to swap between verification and execution.
  const source = new TextDecoder().decode(init.bundle);
  try {
    isolate.runBundle(source, `anon-rpc-worker:${init.address}`);
  } catch (e) {
    // A bundle that threw while evaluating never got to signalFailed for
    // itself, and a guest that exhausted a limit lands here too.
    fail((e as Error)?.message ?? String(e));
  }
}

/** §9 abort for a call the guest already accepted. */
rpc.onEvent("call.abort", ({ id }: { id: number }) => isolate?.abortCall(id));

rpc.onEvent("shutdown", () => shutdown(0));
port.on("close", () => shutdown(0));

// A throw that gets this far has escaped the isolate — harness code, not guest
// code. It still must not leave the isolate's WASM runtime undisposed.
process.on("uncaughtException", (e) => {
  fail(e?.message ?? String(e));
  shutdown(1);
});
process.on("unhandledRejection", (e) => {
  fail((e as Error)?.message ?? String(e));
  shutdown(1);
});

void workerData;
