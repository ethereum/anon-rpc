// The host half of `anonRpcWorker.socket` (a PROPOSED capability — see
// README.md; it is not in SPEC.md).
//
// Why it exists: in a browser the worker cannot open raw TCP at all, which is
// why tor-js needs KPS gateways to reach the Tor network. A Node harness can
// offer real sockets, so a native tor-js needs no gateway — but handing the
// worker ambient sockets would hand it the host's loopback and LAN too. A
// bridged capability gives it the reach without the blast radius, and puts the
// policy decision outside the guest, where it is a boundary rather than a
// filter.
//
// Under QuickJS isolation the guest has no sockets to take away: it has no
// syscalls at all. So this is not a restriction of an ambient ability, it is
// the only network that exists in there, and `anonRpcWorker.socket` being
// absent means absent.
//
// The data path changed with the isolation strategy. The Landlock-process
// harness passed the connected DESCRIPTOR to the child (SCM_RIGHTS) and then
// left the data path entirely — bytes went child ↔ kernel ↔ network with no
// copy through the host. A descriptor cannot move to a worker_thread, and the
// guest could not use one anyway, so bytes are relayed in chunks instead. That
// is a real cost: the host now sees the plaintext it previously could not. For
// a worker doing its own end-to-end encryption (which is the point of tor-js)
// the host sees ciphertext, so what it costs is copies, not confidentiality.
//
// Backpressure survives the change: the guest pulls one chunk per request and
// nothing is read from the peer until it asks, so the kernel's socket buffer
// still does the work.

import net from "node:net";
import { lookup } from "node:dns/promises";
import { Policy, type AddressPolicy } from "./address-policy.js";
import type { Rpc } from "../protocol.js";
import type { GuestPayload, GuestReply } from "../child/isolate-thread.js";

export type SocketBridgeOptions = {
  policy?: AddressPolicy;
  /** Cap on sockets alive at once; every one is an fd in this process. */
  maxConcurrent?: number;
  /** Bytes handed to the guest per `socket.read`. */
  chunkBytes?: number;
};

const DEFAULT_MAX_CONCURRENT = 256;
const DEFAULT_CHUNK_BYTES = 64 * 1024;

function coded(code: string, message: string): Error {
  const e = new Error(message);
  (e as Error & { code: string }).code = code;
  return e;
}

type Bridged = {
  socket: net.Socket;
  /** Chunks read from the peer but not yet pulled by the guest. */
  queue: Uint8Array[];
  /** A guest read parked on an empty queue. */
  waiter?: (v: void) => void;
  ended: boolean;
  closed: boolean;
  closeInfo?: { ok: boolean; reason?: { code: string } };
  closeWaiters: ((v: { ok: boolean; reason?: { code: string } }) => void)[];
};

/**
 * Install the socket handlers. Returns a disposer that destroys every socket
 * this bridge owns — on the QuickJS path the host holds them all, so closing
 * the worker must not leak descriptors.
 */
export function installSocketBridge(rpc: Rpc, opts: SocketBridgeOptions = {}): () => void {
  const policy = new Policy(opts.policy);
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const live = new Map<number, Bridged>();
  let nextId = 1;

  const idOf = (payload: unknown): number | undefined =>
    (((payload as GuestPayload)?.args ?? {}) as { id?: number }).id;

  const get = (payload: unknown): Bridged => {
    const id = idOf(payload);
    const b = typeof id === "number" ? live.get(id) : undefined;
    if (!b) throw coded("protocol-error", `socket: no such socket (${String(id)})`);
    return b;
  };

  // An entry OUTLIVES its socket. The peer can close while bytes the guest has
  // not pulled are still queued here, so releasing the entry when the socket
  // closes would silently truncate the stream — and then fail every later read
  // with "no such socket", which is exactly what it did. Entries are released
  // when the guest is finished with them instead: a read that reports `done`,
  // an explicit close, or the bridge being disposed.
  const release = (id: number | undefined) => {
    if (typeof id !== "number") return;
    const b = live.get(id);
    if (!b) return;
    live.delete(id);
    b.socket.destroy();
  };

  /** Only sockets that are still open count against the concurrency cap. */
  const openCount = () => {
    let n = 0;
    for (const b of live.values()) if (!b.closed) n++;
    return n;
  };

  rpc.on("socket.connect", async (payload: GuestPayload, ctx) => {
    const { host, port } = ((payload?.args ?? {}) as { host?: unknown; port?: unknown });
    if (typeof host !== "string" || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw coded("protocol-error", `socket.connect: bad host/port (${String(host)}:${String(port)})`);
    }
    if (openCount() >= max) {
      throw coded("queue-full", `socket.connect: ${max} concurrent sockets already open`);
    }

    // Resolve first, then dial the RESOLVED address. Checking a name and then
    // connecting by name leaves a window in which the answer can change — and
    // the guest controls the name, so it would control that window too.
    let address: string;
    try {
      ({ address } = await lookup(host, { verbatim: true }));
    } catch (e) {
      throw coded("network-error", `socket.connect: cannot resolve ${host}: ${(e as Error).message}`);
    }

    const decision = policy.check(address);
    if (!decision.ok) {
      throw coded("permission-denied", `socket.connect: ${host} → ${decision.why}`);
    }

    const socket = await dial(address, port as number, ctx.signal);
    const id = nextId++;
    const b: Bridged = { socket, queue: [], ended: false, closed: false, closeWaiters: [] };
    live.set(id, b);

    // Flowing mode with pause/resume as the guest pulls: 'data' arrives, gets
    // queued, and the socket is paused once more than one chunk is waiting, so
    // the peer feels the guest's pace through the kernel's window.
    socket.on("data", (d: Buffer) => {
      b.queue.push(new Uint8Array(d));
      if (b.queue.length > 1) socket.pause();
      b.waiter?.();
      b.waiter = undefined;
    });
    socket.on("end", () => {
      b.ended = true;
      b.waiter?.();
      b.waiter = undefined;
    });
    socket.on("close", (hadError: boolean) => {
      b.closed = true;
      b.ended = true;
      b.closeInfo = hadError ? { ok: false, reason: { code: "network-error" } } : { ok: true };
      b.waiter?.();
      b.waiter = undefined;
      for (const w of b.closeWaiters.splice(0)) w(b.closeInfo);
      // Deliberately still in `live`: see release() above.
    });
    // The guest is untrusted and may never read; an error with no listener
    // would be an unhandled 'error' event taking the host down.
    socket.on("error", () => void 0);

    return { value: { id, remoteAddress: { address, port } } } satisfies GuestReply;
  });

  rpc.on("socket.read", async (payload: GuestPayload) => {
    const b = get(payload);
    for (;;) {
      if (b.queue.length) {
        const chunk = b.queue.shift()!;
        if (b.queue.length <= 1 && !b.closed) b.socket.resume();
        // Split rather than concatenate: a guest asking for one chunk gets at
        // most chunkBytes, so a fast peer cannot make the host buffer grow
        // without bound between pulls.
        if (chunk.byteLength > chunkBytes) {
          b.queue.unshift(chunk.subarray(chunkBytes));
          return { value: { done: false }, bytes: chunk.subarray(0, chunkBytes) } satisfies GuestReply;
        }
        return { value: { done: false }, bytes: chunk } satisfies GuestReply;
      }
      if (b.ended || b.closed) {
        // The guest has read everything there was; the entry can go.
        release(idOf(payload));
        return { value: { done: true } } satisfies GuestReply;
      }
      await new Promise<void>((res) => {
        b.waiter = res;
      });
    }
  });

  rpc.on("socket.write", async (payload: GuestPayload) => {
    const b = get(payload);
    const bytes = payload?.bytes;
    if (!bytes?.byteLength) return {} satisfies GuestReply;
    if (b.closed) throw coded("network-error", "socket.write: socket is closed");
    // Resolves only once the kernel took it, which is what makes the guest's
    // `writable` apply real backpressure rather than buffering here forever.
    await new Promise<void>((res, rej) => {
      b.socket.write(bytes, (err) => (err ? rej(coded("network-error", `socket.write: ${err.message}`)) : res()));
    });
    return {} satisfies GuestReply;
  });

  rpc.on("socket.closed", async (payload: GuestPayload) => {
    // A released socket is a closed socket, so this answers rather than
    // throwing: a guest awaiting `closed` after draining must not get an error
    // for having been tidy.
    const id = idOf(payload);
    if (typeof id === "number" && !live.has(id)) {
      return { value: { ok: true } } satisfies GuestReply;
    }
    const b = get(payload);
    if (b.closeInfo) return { value: b.closeInfo } satisfies GuestReply;
    const info = await new Promise<{ ok: boolean; reason?: { code: string } }>((res) =>
      b.closeWaiters.push(res),
    );
    return { value: info } satisfies GuestReply;
  });

  rpc.onEvent("socket.end", (payload: GuestPayload) => {
    const { id } = ((payload?.args ?? {}) as { id?: number });
    live.get(id as number)?.socket.end();
  });

  rpc.onEvent("socket.close", (payload: GuestPayload) => release(idOf(payload)));

  return () => {
    for (const b of live.values()) b.socket.destroy();
    live.clear();
  };
}

function dial(address: string, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const settle = (fn: () => void) => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onConnect = () => settle(() => resolve(socket));
    const onError = (e: Error) =>
      settle(() => {
        socket.destroy();
        reject(coded("network-error", `socket.connect: ${address}:${port}: ${e.message}`));
      });
    const onAbort = () =>
      settle(() => {
        socket.destroy();
        reject(coded("cancelled", "socket.connect: aborted"));
      });

    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
