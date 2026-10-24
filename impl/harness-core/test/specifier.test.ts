import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { readSpecifier, fetchAndVerifyBundle, toHex, MAX_BUNDLE_BYTES } from "../src/specifier.js";

/* ABI encoders mirroring the decoders under test (same as test/run-e2e.mjs). */
const enc = new TextEncoder();
function pad32(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32 || 32);
  out.set(b);
  return out;
}
function word(n: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
}
function concat(arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function encodeStringArray(strings: string[]): Uint8Array {
  const items = strings.map((s) => enc.encode(s));
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = items.length * 32;
  for (const item of items) {
    heads.push(word(tailOffset));
    const tail = concat([word(item.length), pad32(item)]);
    tails.push(tail);
    tailOffset += tail.length;
  }
  return concat([word(0x20), word(items.length), ...heads, ...tails]);
}
const selector = (sig: string) => "0x" + toHex(keccak_256(enc.encode(sig))).slice(0, 8);

function mockProvider(map: Record<string, string>) {
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      assert.equal(method, "eth_call");
      const data = (params as [{ data: string }])[0].data;
      const ret = map[data.slice(0, 10)];
      if (!ret) throw new Error(`no mock for ${data}`);
      return ret;
    },
  };
}

test("readSpecifier decodes workerHash and workerResolvers", async () => {
  const hash = "0x" + "ab".repeat(32);
  const resolvers = ["https://a.test/w.js", "https://mirror.test/some/longer/path/w.js"];
  const provider = mockProvider({
    [selector("workerHash()")]: hash,
    [selector("workerResolvers()")]: "0x" + toHex(encodeStringArray(resolvers)),
  });
  const spec = await readSpecifier(provider, "0x" + "01".repeat(20));
  assert.equal(spec.workerHash, hash);
  assert.deepEqual(spec.resolvers, resolvers);
});

test("readSpecifier rejects malicious ABI data instead of hanging/OOM", async () => {
  // Length word of 2^255: bounds checks must throw, not loop.
  const huge = concat([word(0x20), pad32(new Uint8Array([0x80]))]); // len word = huge value
  const provider = mockProvider({
    [selector("workerHash()")]: "0x" + "ab".repeat(32),
    [selector("workerResolvers()")]: "0x" + toHex(huge),
  });
  await assert.rejects(readSpecifier(provider, "0x" + "01".repeat(20)), /ABI decode/);
});

test("readSpecifier rejects truncated ABI data", async () => {
  const provider = mockProvider({
    [selector("workerHash()")]: "0x" + "ab".repeat(32),
    [selector("workerResolvers()")]: "0x" + toHex(word(0x20)), // offset points past the buffer
  });
  await assert.rejects(readSpecifier(provider, "0x" + "01".repeat(20)), /ABI decode/);
});

// fetchAndVerifyBundle uses global fetch; substitute a scripted one per test.
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

const bundle = enc.encode("// the worker bundle bytes");
const bundleHash = "0x" + toHex(keccak_256(bundle));

test("fetchAndVerifyBundle accepts hash-matching bytes", async () => {
  await withFetch(async () => new Response(bundle), async () => {
    const got = await fetchAndVerifyBundle({ workerHash: bundleHash, resolvers: ["https://r.test/w.js"] });
    assert.deepEqual(got, bundle);
  });
});

test("fetchAndVerifyBundle rejects non-matching bytes (§4)", async () => {
  await withFetch(async () => new Response(enc.encode("evil bytes")), async () => {
    await assert.rejects(
      fetchAndVerifyBundle({ workerHash: bundleHash, resolvers: ["https://r.test/w.js"] }),
      /hash mismatch/,
    );
  });
});

test("fetchAndVerifyBundle rejects a body past the size cap (§4.2)", async () => {
  await withFetch(async () => new Response(new Uint8Array(2048)), async () => {
    await assert.rejects(
      fetchAndVerifyBundle({ workerHash: bundleHash, resolvers: ["https://big.test/w.js"] }, 1024),
      /bundle cap/,
    );
  });
});

test("fetchAndVerifyBundle cancels an oversized STREAMED body at the cap", async () => {
  let pulls = 0;
  let cancelled = false;
  // An endless stream: only the cap can stop it.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(512));
    },
    cancel() {
      cancelled = true;
    },
  });
  await withFetch(async () => new Response(body), async () => {
    await assert.rejects(
      fetchAndVerifyBundle({ workerHash: bundleHash, resolvers: ["https://endless.test/w.js"] }, 1024),
      /bundle cap/,
    );
  });
  assert.ok(cancelled, "the body stream must be cancelled at the cap");
  assert.ok(pulls <= 4, `read far past the cap (${pulls} pulls of 512B against a 1024B cap)`);
});

test("fetchAndVerifyBundle falls through an oversized resolver to a good one", async () => {
  const impl: typeof fetch = async (url) =>
    String(url).includes("big.test") ? new Response(new Uint8Array(2048)) : new Response(bundle);
  await withFetch(impl, async () => {
    const got = await fetchAndVerifyBundle(
      { workerHash: bundleHash, resolvers: ["https://big.test/w.js", "https://good.test/w.js"] },
      1024,
    );
    assert.deepEqual(got, bundle);
  });
});

test("fetchAndVerifyBundle ignores unrecognized resolver kinds (§4.1)", async () => {
  const calls: string[] = [];
  const impl: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(bundle);
  };
  await withFetch(impl, async () => {
    const got = await fetchAndVerifyBundle({
      workerHash: bundleHash,
      resolvers: ["ipfs://bafyfuture", "https://good.test/w.js"],
    });
    assert.deepEqual(got, bundle);
    // The unrecognized entry must not be attempted as a URL fetch.
    assert.deepEqual(calls, ["https://good.test/w.js"]);
  });
});

test("only-unrecognized resolvers fail with an explanatory error", async () => {
  await withFetch(async () => new Response(bundle), async () => {
    await assert.rejects(
      fetchAndVerifyBundle({ workerHash: bundleHash, resolvers: ["ipfs://bafyfuture"] }),
      /unrecognized resolver kind/,
    );
  });
});

test("the default bundle cap is 64 MiB", () => {
  assert.equal(MAX_BUNDLE_BYTES, 64 * 1024 * 1024);
});

test("fetchAndVerifyBundle falls through failing resolvers to a good one", async () => {
  const calls: string[] = [];
  const impl: typeof fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("nope", { status: 500 });
    if (calls.length === 2) return new Response(enc.encode("wrong bytes"));
    return new Response(bundle);
  };
  await withFetch(impl, async () => {
    const got = await fetchAndVerifyBundle({
      workerHash: bundleHash,
      resolvers: ["https://down.test/w.js", "https://tampered.test/w.js", "https://good.test/w.js"],
    });
    assert.deepEqual(got, bundle);
    assert.equal(calls.length, 3);
  });
});
