// The host half of `anonRpcWorker.socket` (a PROPOSED capability — see
// README.md; it is not in SPEC.md).
//
// The worker cannot dial: the child is spawned with Landlock denying every TCP
// connect, so asking the host is its only route to the network. The host
// resolves, applies the address policy, dials, and hands the connected
// descriptor over. After that the host is off the data path entirely — bytes go
// child ↔ kernel ↔ network, with no copy through this process and no flow
// control of ours, because the socket buffer is the backpressure.
//
// Why this exists: in a browser the worker cannot open raw TCP at all, which is
// why tor-js needs KPS gateways to reach the Tor network. A Node harness can
// offer real sockets, so a native tor-js needs no gateway — but handing the
// worker ambient sockets would also hand it the host's loopback and LAN. A
// bridged capability gives it the reach without the blast radius, and puts the
// policy decision outside the sandbox where it is a boundary rather than a
// filter.

import net from "node:net";
import { lookup } from "node:dns/promises";
import { Policy, type AddressPolicy } from "./address-policy.js";
import { withHandle, type Rpc } from "../protocol.js";

export type SocketBridgeOptions = {
  policy?: AddressPolicy;
  /** Cap on sockets alive at once; every one is an fd in both processes. */
  maxConcurrent?: number;
};

const DEFAULT_MAX_CONCURRENT = 256;

function coded(code: string, message: string): Error {
  const e = new Error(message);
  (e as Error & { code: string }).code = code;
  return e;
}

/**
 * Install the `socket.connect` handler. Returns a disposer that destroys any
 * socket still being dialled when the worker is closed.
 */
export function installSocketBridge(rpc: Rpc, opts: SocketBridgeOptions = {}): () => void {
  const policy = new Policy(opts.policy);
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  // Only sockets still in our hands are tracked. Once a descriptor is sent, the
  // child owns it and this process no longer has a copy to close.
  const dialling = new Set<net.Socket>();
  let live = 0;

  rpc.on("socket.connect", async (args: { host: string; port: number }, ctx) => {
    const { host, port } = args ?? ({} as { host: string; port: number });
    if (typeof host !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw coded("protocol-error", `socket.connect: bad host/port (${host}:${port})`);
    }
    if (live >= max) {
      throw coded("queue-full", `socket.connect: ${max} concurrent sockets already open`);
    }

    // Resolve first, then dial the RESOLVED address. Checking a name and then
    // connecting by name leaves a window in which the answer can change —
    // the worker controls the name, so it would control that window too.
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

    const socket = await dial(address, port, ctx.signal, dialling);
    live++;
    socket.once("close", () => void live--);

    // The handle rides with the response. Node closes OUR copy once sent, so
    // this is a transfer of ownership, not a share: the harness structurally
    // cannot observe the worker's traffic afterwards.
    return withHandle({ remoteAddress: { address, port } }, socket);
  });

  return () => {
    for (const s of dialling) s.destroy();
    dialling.clear();
  };
}

function dial(
  address: string,
  port: number,
  signal: AbortSignal,
  tracking: Set<net.Socket>,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    tracking.add(socket);

    const settle = (fn: () => void) => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onConnect = () =>
      settle(() => {
        tracking.delete(socket);
        // Paused so nothing is read on this side: the first read must happen
        // in the child, or bytes would be buffered here and lost on transfer.
        socket.pause();
        resolve(socket);
      });
    const onError = (e: Error) =>
      settle(() => {
        tracking.delete(socket);
        reject(coded("network-error", `socket.connect: ${address}:${port}: ${e.message}`));
      });
    const onAbort = () =>
      settle(() => {
        tracking.delete(socket);
        socket.destroy();
        reject(coded("cancelled", "socket.connect: aborted"));
      });

    socket.once("connect", onConnect);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
