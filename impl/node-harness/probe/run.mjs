// Finds the minimum Landlock grant set a Node worker process needs, by running
// probe.mjs under progressively wider rulesets and printing what each bought.
//
// The ladder is the interesting output, not just the last rung: it shows that
// node cannot start at all until OpenSSL can read its config, and that DNS
// stays broken until the resolver's files are reachable — neither of which is
// obvious from the outside, and both of which are grants we would rather make
// deliberately than by handing over all of /etc.
//
// Every scenario spawns with a scrubbed environment (env: {}), since the
// permission model does not cover process.env and §6 forbids the worker seeing
// the host's secrets.
//
//   node probe/run.mjs              # the whole ladder
//   node probe/run.mjs resolver     # one scenario, verbose

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCH = resolve(HERE, "../launcher/anon-rpc-launch");
const PROBE = resolve(HERE, "probe.mjs");
const NODE = process.execPath;

// Paths the probe tries to read and must never reach: the host's real secrets,
// not synthetic ones. If any comes back readable, the sandbox is not working.
const HOME = process.env.HOME;
const FORBIDDEN = ["/etc/passwd", `${HOME}/.ssh/id_ed25519`, `${HOME}/.bashrc`];

// Cumulative — each rung adds to the ones above it.
const LADDER = [
  ["nothing", []],
  ["node binary", ["--ro", dirname(NODE)]],
  ["libs", ["--ro", "/lib", "--ro", "/usr/lib"]],
  ["proc+dev", ["--ro", "/proc", "--rw", "/dev/null", "--ro", "/dev/urandom"]],
  ["bundle dir", ["--ro", HERE]],
  // node aborts on startup without this: OpenSSL fopen()s its config from C,
  // below the permission model, so only landlock can let it through.
  ["openssl cfg", ["--ro", "/etc/ssl"]],
  // /etc/resolv.conf is a symlink into /run on systemd hosts, and landlock
  // rules follow the target — so granting /etc alone leaves DNS broken.
  ["resolver", ["--ro", "/etc/resolv.conf", "--ro", "/run/systemd/resolve",
                "--ro", "/etc/hosts", "--ro", "/etc/nsswitch.conf", "--ro", "/etc/gai.conf"]],
];

const only = process.argv[2];
let grants = [];
const rows = [];

for (const [name, add] of LADDER) {
  grants = [...grants, ...add];
  if (only && !name.includes(only)) continue;

  const r = spawnSync(LAUNCH, [...grants, "--", NODE, "--permission", PROBE, ...FORBIDDEN], {
    encoding: "utf8",
    timeout: 30_000,
    env: {}, // closes the process.env hole the permission model leaves open
  });
  const landlock = (r.stderr.match(/landlock ([^\n]*)/) ?? [])[1] ?? "?";
  let probe = null;
  try {
    probe = JSON.parse(r.stdout);
  } catch {
    /* node never got far enough to print */
  }
  rows.push({ name, grants: [...grants], landlock, probe, stderr: r.stderr });

  if (only) {
    console.log(`\n=== ${name} ===\ngrants: ${grants.join(" ") || "(none)"}\nlandlock: ${landlock}`);
    if (probe) for (const [k, v] of Object.entries(probe)) console.log(`  ${v.ok ? "✓" : "✗"} ${k}: ${v.ok ? v.value : v.err}`);
    else console.log("stderr:", r.stderr.trim().slice(0, 700));
  }
}
if (only) process.exit(0);

const keys = Object.keys(rows.findLast((r) => r.probe)?.probe ?? {});
const CW = 13;
const cell = (s) => String(s).padStart(CW);
console.log("\nminimum landlock grant set for a Node worker (ABI 4, --permission, env scrubbed)\n");
console.log("check".padEnd(22) + rows.map((r) => cell(r.name.slice(0, CW - 1))).join(""));
console.log("-".repeat(22 + CW * rows.length));
console.log("node starts".padEnd(22) + rows.map((r) => cell(r.probe ? "yes" : "NO")).join(""));
for (const k of keys) {
  console.log(
    k.replace(HOME, "~").slice(0, 21).padEnd(22) +
      rows.map((r) => cell(!r.probe ? "-" : r.probe[k]?.ok ? "ok" : "denied")).join(""),
  );
}

const first = rows.find((r) => r.probe);
const last = rows[rows.length - 1];
console.log(`\nnode first boots at: ${first?.name ?? "(never)"}`);
console.log(`\nminimal grant set:\n  ${last.grants.join(" ")}`);
const leaked = keys.filter((k) => k.startsWith("READ ") && last.probe?.[k]?.ok);
console.log(leaked.length ? `\n!! READABLE HOST PATHS: ${leaked.join(", ")}` : "\nno host path was readable in any scenario");
