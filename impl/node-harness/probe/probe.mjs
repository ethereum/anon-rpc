// Runs INSIDE the sandbox and reports what it can still reach, as JSON on
// stdout. Every check is a thing a real worker either needs (sockets, entropy,
// its own bundle) or must never have (the host's home directory, the host's
// env, spawning processes).
//
// Nothing here throws out: a probe that dies on the first denial tells us only
// which check happened to run first.

const out = {};
const check = async (name, fn) => {
  try {
    out[name] = { ok: true, value: (await fn()) ?? true };
  } catch (e) {
    out[name] = { ok: false, err: e.code ?? e.name ?? String(e.message ?? e).slice(0, 80) };
  }
};

const fs = await import("node:fs/promises").catch(() => null);

// --- things a worker legitimately needs -----------------------------------
await check("read own bundle", () => fs.readFile(new URL(import.meta.url)).then((b) => b.length));
await check("entropy", async () => (await import("node:crypto")).randomBytes(16).length);
await check("write tmp", async () => {
  const p = `/tmp/anon-rpc-probe-${process.pid}`;
  await fs.writeFile(p, "x");
  await fs.rm(p);
  return "rw";
});
await check("dns", async () => (await (await import("node:dns/promises")).lookup("one.one.one.one")).address);
await check("tcp connect", async () => {
  const net = await import("node:net");
  return await new Promise((res, rej) => {
    const s = net.connect(443, "1.1.1.1");
    s.on("connect", () => { s.destroy(); res("1.1.1.1:443"); });
    s.on("error", rej);
    setTimeout(() => { s.destroy(); rej(new Error("timeout")); }, 4000);
  });
});
await check("tls fetch", async () => {
  const r = await fetch("https://one.one.one.one/", { signal: AbortSignal.timeout(6000) });
  return r.status;
});
await check("intl/icu", () => new Intl.DateTimeFormat("de-DE").format(new Date(0)));

// --- things it must NOT have ----------------------------------------------
// The host's files. In this repo that is the actual threat: a worker reading
// ~/.ssh or another project's .env is the whole reason for the sandbox.
for (const p of process.argv.slice(2)) {
  await check(`READ ${p}`, () => fs.readFile(p, "utf8").then((s) => s.length + " bytes"));
}
await check("spawn", async () => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("/bin/echo", ["hi"], { encoding: "utf8" }).trim();
});
await check("worker_threads", async () => {
  const { Worker } = await import("node:worker_threads");
  const w = new Worker("", { eval: true });
  await w.terminate();
  return "created";
});
await check("native addon", async () => {
  process.dlopen({ exports: {} }, "/nonexistent.node");
  return "dlopen reached";
});

out["env vars"] = { ok: true, value: Object.keys(process.env).length };
out["permission model"] = {
  ok: true,
  value: process.permission ? (process.permission.has("fs.read") ? "on, fs.read GRANTED" : "on, fs denied") : "off",
};

process.stdout.write(JSON.stringify(out));
