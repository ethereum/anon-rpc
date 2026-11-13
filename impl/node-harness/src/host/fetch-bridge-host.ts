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
import { Agent } from "undici";
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
// The platform's own limit (Fetch: "redirect count"), kept small here.
const MAX_REDIRECTS = 5;
// Connection pools kept at once, one per checked address; the oldest is closed
// when a new address would exceed this.
const MAX_POOLS = 32;

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

  // Node's fetch would resolve a name again when it connects, and a name whose
  // answer changes in between (DNS rebinding) would then reach an address that
  // was never checked. So connections go through an undici Agent whose lookup
  // returns one checked address and nothing else. Agents are kept per address,
  // so requests to the same checked address reuse connections; a name that
  // later resolves elsewhere gets a different Agent. The URL keeps the name, so
  // Host, TLS SNI and certificate checks are unchanged.
  const pools = new Map<string, Agent>();
  function poolFor(dest: { address: string; family: number }): Agent {
    const key = `${dest.family}/${dest.address}`;
    let pool = pools.get(key);
    if (!pool) {
      pool = new Agent({
        connect: {
          lookup: (_host, options, callback) =>
            options?.all
              ? callback(null, [{ address: dest.address, family: dest.family }])
              : callback(null, dest.address, dest.family),
        },
      });
      pools.set(key, pool);
      if (pools.size > MAX_POOLS) {
        const [oldestKey, oldest] = pools.entries().next().value!;
        pools.delete(oldestKey);
        void oldest.close();
      }
    }
    return pool;
  }

  // Same discipline as socket.connect: resolve, then decide on the RESOLVED
  // address, and connect to that address (poolFor, above), never to
  // a second answer for the same name.
  async function checkDestination(url: URL): Promise<{ address: string; family: number }> {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw coded("permission-denied", `fetch: ${url.protocol} is not allowed`);
    }
    let address: string;
    let family: number;
    try {
      ({ address, family } = await lookup(url.hostname, { verbatim: true }));
    } catch (e) {
      throw coded("network-error", `fetch: cannot resolve ${url.hostname}: ${(e as Error).message}`);
    }
    const decision = policy.check(address);
    if (!decision.ok) {
      throw coded("permission-denied", `fetch: ${url.hostname} → ${decision.why}`);
    }
    return { address, family };
  }

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
    let dest = await checkDestination(url);

    const ac = new AbortController();
    inFlight.add(ac);
    // The guest's abort arrives as an Rpc abort on this call.
    ctx.signal.addEventListener("abort", () => ac.abort(), { once: true });

    try {
      let headers = Array.isArray(req.headers)
        ? (req.headers as [string, string][]).filter(
            (h) => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string",
          )
        : [];
      // Redirects are followed here, not by the fetch implementation, so every
      // hop passes the same address check as the first URL. Following them
      // blindly would let any reachable server send the guest to the host's own
      // network (loopback, private ranges, cloud metadata). 303, and 301/302 on
      // POST, become GET as the platform does; a hop to another origin drops
      // Authorization, as the platform does.
      const mode = req.redirect === "error" || req.redirect === "manual" ? req.redirect : "follow";
      let method = typeof req.method === "string" ? req.method : "GET";
      let body = payload?.bytes?.byteLength ? payload.bytes : undefined;
      let response: Response;
      for (let hops = 0; ; hops++) {
        response = await impl(url, {
          method,
          headers,
          ...(body ? { body } : {}),
          redirect: "manual",
          signal: ac.signal,
          dispatcher: poolFor(dest),
          // Node's fetch takes an undici dispatcher; its RequestInit type names
          // one from an older undici-types, which this Agent does not match.
        } as unknown as RequestInit);
        const location = response.headers.get("location");
        if (response.status < 300 || response.status > 399 || !location || mode === "manual") break;
        if (mode === "error") throw coded("network-error", 'fetch: redirected, and redirect is "error"');
        if (hops >= MAX_REDIRECTS) throw coded("network-error", `fetch: more than ${MAX_REDIRECTS} redirects`);
        const next = new URL(location, url);
        await response.body?.cancel();
        dest = await checkDestination(next);
        if (next.origin !== url.origin) headers = headers.filter(([k]) => k.toLowerCase() !== "authorization");
        url = next;
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
      }

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
    for (const pool of pools.values()) void pool.close();
    pools.clear();
  };
}
