// The host half of a granted `fetch`.
//
// This file only exists because of the isolation strategy. In a browser Web
// Worker, and in the `node:vm` harness, `fetch` is ambient: it is there whether
// you want it or not, and the most a harness can do is confine what it reaches
// (Landlock, in the process-based path). A QuickJS isolate has no fetch, no
// sockets and no syscalls, so `fetch` is something the host hands over — or
// does not.
//
// That turns a platform fact into a policy decision, and it is the same
// decision the socket capability makes: the guest names a destination, the host
// resolves it, checks the RESOLVED address against its policy, and performs the
// request itself. A worker written against the browser platform — the reference
// passthrough worker answers every call with a plain `fetch` — runs unchanged,
// while the host sees every request it makes.
//
// Bodies are buffered in both directions. §9 permits a stream but does not
// require one, and streaming here means a chunk protocol like the socket
// capability's; the note in README says what that would buy.

import { lookup } from "node:dns/promises";
import { Policy, type AddressPolicy } from "./address-policy.js";
import type { Rpc } from "../protocol.js";
import type { GuestPayload, GuestReply } from "../child/isolate-thread.js";

export type FetchBridgeOptions = {
  /**
   * Which addresses the guest may reach. Defaults to the same deny-by-default
   * policy as the socket capability: no loopback, no RFC1918, no link-local.
   */
  policy?: AddressPolicy;
  /** Cap on requests in flight at once. */
  maxConcurrent?: number;
  /** Cap on a response body handed to the guest, which must fit its heap. */
  maxResponseBytes?: number;
  /** The `fetch` the host performs with. Injectable so tests need no network. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_MAX_CONCURRENT = 16;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function coded(code: string, message: string): Error {
  const e = new Error(message);
  (e as Error & { code: string }).code = code;
  return e;
}

/** Install the `fetch` handler. Returns a disposer that aborts what is in flight. */
export function installFetchBridge(rpc: Rpc, opts: FetchBridgeOptions = {}): () => void {
  const policy = new Policy(opts.policy);
  const max = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const impl = opts.fetchImpl ?? fetch;
  const inFlight = new Set<AbortController>();

  rpc.on("fetch", async (payload: GuestPayload, ctx) => {
    const req = (payload?.args ?? {}) as {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      redirect?: unknown;
    };
    if (typeof req.url !== "string") {
      throw coded("protocol-error", "fetch: url must be a string");
    }
    if (inFlight.size >= max) {
      throw coded("queue-full", `fetch: ${max} requests already in flight`);
    }

    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw coded("protocol-error", `fetch: not a valid URL: ${req.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw coded("permission-denied", `fetch: ${url.protocol} is not allowed`);
    }

    // Same discipline as socket.connect: resolve, then decide on the RESOLVED
    // address. Node's fetch resolves again when it dials, so this is a check
    // rather than a guarantee — a name whose answer changes in between could
    // still be reached. Closing that needs a custom dispatcher pinned to the
    // checked address; noted in README rather than pretended away.
    let address: string;
    try {
      ({ address } = await lookup(url.hostname, { verbatim: true }));
    } catch (e) {
      throw coded("network-error", `fetch: cannot resolve ${url.hostname}: ${(e as Error).message}`);
    }
    const decision = policy.check(address);
    if (!decision.ok) {
      throw coded("permission-denied", `fetch: ${url.hostname} → ${decision.why}`);
    }

    const ac = new AbortController();
    inFlight.add(ac);
    // The guest's abort arrives as an Rpc abort on this call.
    ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });

    try {
      const headers = Array.isArray(req.headers)
        ? (req.headers as [string, string][]).filter(
            (h) => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string",
          )
        : [];
      const response = await impl(url, {
        method: typeof req.method === "string" ? req.method : "GET",
        headers,
        ...(payload?.bytes?.byteLength ? { body: payload.bytes } : {}),
        ...(req.redirect === "follow" || req.redirect === "error" || req.redirect === "manual"
          ? { redirect: req.redirect }
          : {}),
        signal: ac.signal,
      });

      const buf = await response.arrayBuffer();
      if (buf.byteLength > maxBytes) {
        throw coded("resource-limit", `fetch: response is ${buf.byteLength} bytes (limit ${maxBytes})`);
      }
      const outHeaders: [string, string][] = [];
      response.headers.forEach((v, k) => outHeaders.push([k, v]));

      return {
        value: {
          status: response.status,
          statusText: response.statusText,
          headers: outHeaders,
          url: response.url,
        },
        bytes: new Uint8Array(buf),
      } satisfies GuestReply;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw coded("cancelled", "fetch: aborted");
      if (typeof (e as { code?: unknown })?.code === "string") throw e;
      throw coded("network-error", `fetch: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      inFlight.delete(ac);
    }
  });

  return () => {
    for (const ac of inFlight) ac.abort();
    inFlight.clear();
  };
}
