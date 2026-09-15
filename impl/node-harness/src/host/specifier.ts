// §4 — Worker identity and integrity.
//
// Reads an on-chain IWorkerSpecifier (workerHash() / workerResolvers()) through
// a pre-existing RPC provider, fetches the bundle bytes from a resolver, and
// verifies keccak256(bytes) == workerHash. The hash is trust; the URL is not.
//
// Copied from the browser harness, minus its `kps:` resolver support (§4.2),
// which needs a KPS transport this harness does not have yet. §4 is entirely
// platform-neutral — chain read, byte fetch, hash compare — so the two
// implementations agreeing here is a property worth keeping, not a smell.

import { keccak_256 } from "@noble/hashes/sha3";
import type { RpcProvider } from "../spec-types.js";

const SEL_WORKER_HASH = selector("workerHash()");
const SEL_WORKER_RESOLVERS = selector("workerResolvers()");

function selector(sig: string): string {
  return "0x" + toHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export type Specifier = { workerHash: string; resolvers: string[] };

export async function readSpecifier(
  provider: RpcProvider,
  address: string,
): Promise<Specifier> {
  const hashRet = await ethCall(provider, address, SEL_WORKER_HASH);
  const resolversRet = await ethCall(provider, address, SEL_WORKER_RESOLVERS);
  return {
    workerHash: "0x" + decodeBytes32(hashRet),
    resolvers: decodeStringArray(resolversRet),
  };
}

async function ethCall(provider: RpcProvider, to: string, data: string): Promise<Uint8Array> {
  const res = await provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  if (typeof res !== "string") throw new Error("eth_call did not return data");
  return hexToBytes(res);
}

// §4.2: a harness SHOULD cap the accepted body size. A resolver is untrusted
// input; without a cap it can make the harness buffer arbitrarily many bytes
// before the hash check ever runs.
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

// Read a response body, streaming and counting: past the cap the read is
// cancelled without buffering the excess.
async function readBodyCapped(resp: Response, cap: number): Promise<Uint8Array> {
  const overflow = () => new Error(`body exceeds the ${cap}-byte bundle cap`);
  if (!resp.body) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > cap) throw overflow();
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw overflow();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Fetch bundle bytes from the first working resolver and verify the hash (§4). */
export async function fetchAndVerifyBundle(
  spec: Specifier,
  maxBytes = MAX_BUNDLE_BYTES,
): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const url of spec.resolvers) {
    let bytes: Uint8Array;
    try {
      // §4.1 entry kinds. `http:` is accepted alongside `https:` as a
      // development affordance (local resolvers in tests and demos).
      if (/^https?:\/\//.test(url)) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        bytes = await readBodyCapped(resp, maxBytes);
      } else {
        // §4.1: `kps:` entries land here for now. Ignoring an entry kind the
        // harness cannot serve is exactly what §4.1 prescribes, so a specifier
        // listing both kinds still boots — it just falls through to https.
        // §4.1: unrecognized entry kinds MUST be ignored — they never fail
        // the boot; recorded only for the all-resolvers-failed diagnostic.
        errors.push(`${url}: unrecognized resolver kind (ignored)`);
        continue;
      }
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
      continue;
    }
    const got = "0x" + toHex(keccak_256(bytes));
    if (got !== spec.workerHash) {
      // A resolver served bytes that don't match the pinned hash: reject and
      // try the next one. Any bytes matching the hash are acceptable (§4).
      errors.push(`${url}: hash mismatch (got ${got}, want ${spec.workerHash})`);
      continue;
    }
    return bytes;
  }
  throw new Error(`no resolver yielded bytes matching workerHash: ${errors.join("; ")}`);
}

/* --- minimal ABI return decoding (bytes32, string[]) --- */

function decodeBytes32(ret: Uint8Array): string {
  if (ret.length < 32) throw new Error("short bytes32 return");
  return toHex(ret.slice(0, 32));
}

// ABI return data comes from an untrusted RPC endpoint; every offset and
// length is bounds-checked so malicious data throws instead of OOM/hanging.
function word(ret: Uint8Array, at: number): number {
  if (at < 0 || at + 32 > ret.length) throw new Error("ABI decode: word out of bounds");
  let n = 0;
  for (let i = at; i < at + 32; i++) {
    n = n * 256 + ret[i];
    if (n > Number.MAX_SAFE_INTEGER) throw new Error("ABI decode: word too large");
  }
  return n;
}

function decodeStringArray(ret: Uint8Array): string[] {
  // Return is a single dynamic value: head word is the offset to the array.
  const base = word(ret, 0);
  const len = word(ret, base);
  if (base + 32 + len * 32 > ret.length) throw new Error("ABI decode: array length out of bounds");
  const out: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < len; i++) {
    const elemOff = base + 32 + word(ret, base + 32 + i * 32);
    const strLen = word(ret, elemOff);
    if (elemOff + 32 + strLen > ret.length) throw new Error("ABI decode: string out of bounds");
    out.push(dec.decode(ret.slice(elemOff + 32, elemOff + 32 + strLen)));
  }
  return out;
}
