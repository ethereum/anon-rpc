// Spawning the worker process under kernel-enforced confinement.
//
// The grant set below is the one established empirically by probe/run.mjs —
// see README.md for the ladder. Two entries are non-obvious and must not be
// "tidied away": node aborts at startup if OpenSSL cannot read its config, and
// /etc/resolv.conf is usually a symlink whose target Landlock follows, so the
// real path has to be granted rather than the link.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the worker process is confined.
 *
 * `landlock` is the only mode that satisfies §6 for untrusted code. `none`
 * exists because there are hosts where nothing is available (non-Linux, or a
 * kernel below 5.13), and a caller who knowingly accepts that is better served
 * by an explicit acknowledgement than by a silent downgrade — so it demands
 * one, and the harness says so in its error otherwise.
 */
export type Confinement =
  | { kind: "landlock"; launcher?: string }
  | { kind: "none"; acknowledgeUnconfined: true };

const HERE = dirname(fileURLToPath(import.meta.url));

/** The Go launcher. Built by `npm run build:launcher`; shipped per-platform. */
export function defaultLauncherPath(): string {
  return resolve(HERE, "../launcher/anon-rpc-launch");
}

/** The script the confined child runs. Its directory is granted read access. */
export function workerHostPath(): string {
  // dist/host.js and dist/worker-host.js are siblings after a build; in a
  // ts-run/dev context HERE is src/host, so fall back to the built file.
  const beside = resolve(HERE, "worker-host.js");
  return existsSync(beside) ? beside : resolve(HERE, "../../dist/worker-host.js");
}

/**
 * Read-only grants node itself needs before it can run anything at all.
 * Missing paths are dropped: the launcher fatals on a grant it cannot stat,
 * and hosts differ (no /run/systemd on a non-systemd box, no /lib64 on arm).
 */
function nodeRuntimeGrants(): { ro: string[]; rw: string[] } {
  const ro = [
    dirname(process.execPath), // execve, plus the loader reading the binary
    "/lib",
    "/lib64",
    "/usr/lib",
    "/proc", // node reads /proc/self/*, meminfo, cpuinfo
    "/dev/urandom",
    // Node ABORTS on startup without this: OpenSSL fopen()s openssl.cnf from
    // C, below the permission model, so only Landlock can let it through and
    // the failure names no sandbox.
    "/etc/ssl",
    // Resolver inputs. resolv.conf is commonly a symlink into /run, and
    // Landlock rules follow the target — granting /etc alone leaves DNS
    // failing with EAI_AGAIN.
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/gai.conf",
    "/etc/resolv.conf",
    realpath("/etc/resolv.conf"),
  ];
  return { ro: unique(ro.filter(exists)), rw: ["/dev/null"].filter(exists) };
}

const exists = (p: string | undefined): p is string => !!p && existsSync(p);
const realpath = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const unique = (xs: string[]): string[] => [...new Set(xs)];

export type SpawnedWorker = {
  child: ChildProcess;
  /** Resolves once the kernel has confirmed enforcement, rejects otherwise. */
  confined: Promise<void>;
  /** Everything the child wrote to stderr, for diagnostics. */
  stderr(): string;
};

/**
 * Spawn the worker process. The environment is EMPTY: `process.env` is not
 * covered by the permission model or by Landlock, and in Node it is where a
 * host keeps its keys — the direct analogue of §6's private-key clause.
 *
 * The returned `confined` promise is the gate the caller must await before
 * handing over the worker bundle. Delivering untrusted code to a process whose
 * sandbox has not been confirmed would defeat the point of having one.
 */
export type SpawnOptions = {
  /**
   * Leave the child's own sockets working. Off by default: a worker that
   * reaches the network through `anonRpcWorker.socket` needs none of its own,
   * and denying them is what stops it reaching the host's loopback and LAN —
   * kernel-enforced, unlike any check we could run inside the child.
   *
   * It has to be an option because a §3.2-conforming worker MAY use the
   * ambient platform, and the reference passthrough worker does exactly that:
   * it answers calls with a plain `fetch`. Such a worker cannot run with this
   * off, so the host says which kind it is deploying.
   *
   * Caveat measured on Landlock ABI 4: only TCP is denied. UDP bind and send
   * stay open until the ABI that adds them (and abstract unix sockets until
   * Landlock scoping), so this is "no TCP", not "no network".
   */
  ambientNetwork?: boolean;
};

export function spawnWorkerProcess(
  confinement: Confinement,
  opts: SpawnOptions = {},
): SpawnedWorker {
  const host = workerHostPath();
  if (!existsSync(host)) {
    throw new Error(`worker host script not found at ${host} — run \`npm run build\``);
  }

  // `--permission` is a seat belt, not the boundary: upstream documents that it
  // does not stop malicious code. It is worth having anyway — it denies fs,
  // child_process, worker_threads and dlopen at the runtime level, which turns
  // a merely buggy worker's mistake into a clean error.
  const nodeArgs = ["--permission", host];

  if (confinement.kind === "none") {
    const child = spawn(process.execPath, nodeArgs, {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
      env: {},
    });
    return { child, confined: Promise.resolve(), stderr: collect(child) };
  }

  const { ro, rw } = nodeRuntimeGrants();
  const args = [
    ...ro.flatMap((p) => ["--ro", p]),
    ...rw.flatMap((p) => ["--rw", p]),
    // No --connect-port rules alongside it: the deny is total, and the worker's
    // network arrives as descriptors the host passes in. Landlock governs
    // opening, not existing fds, so a handed-in socket keeps working.
    ...(opts.ambientNetwork ? [] : ["--restrict-net"]),
    // The child reads its own host script. The worker bundle is NOT on disk —
    // it arrives over IPC as the bytes the harness already hash-verified — so
    // no grant is needed for it.
    "--ro",
    dirname(host),
    "--",
    process.execPath,
    ...nodeArgs,
  ];

  const launcher = confinement.launcher ?? defaultLauncherPath();
  if (!existsSync(launcher)) {
    throw new Error(
      `landlock launcher not found at ${launcher} — run \`npm run build:launcher\` ` +
        `(or pass confinement.launcher, or opt out explicitly with ` +
        `{ kind: "none", acknowledgeUnconfined: true })`,
    );
  }

  const child = spawn(launcher, args, {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "advanced",
    env: {},
  });
  const stderr = collect(child);

  // The launcher prints exactly one enforcement line before it execs node.
  // Anything else — partial enforcement on an old kernel, a missing grant, a
  // container whose seccomp profile blocks the landlock syscalls — is a hard
  // error, never a log message.
  const confined = new Promise<void>((res, rej) => {
    const timer = setTimeout(
      () => rej(new Error(`launcher did not confirm confinement within 10s: ${stderr()}`)),
      10_000,
    );
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const onData = () => {
      const text = stderr();
      if (text.includes("landlock fully enforced")) {
        child.stderr?.off("data", onData);
        done(res);
      } else if (/anon-rpc-launch: /.test(text)) {
        child.stderr?.off("data", onData);
        done(() => rej(new Error(`confinement failed: ${text.trim()}`)));
      }
    };
    child.stderr?.on("data", onData);
    child.once("error", (e) => done(() => rej(e)));
    child.once("exit", (code) =>
      done(() => rej(new Error(`worker process exited (${code}) before confinement: ${stderr()}`))),
    );
  });

  return { child, confined, stderr };
}

/** Buffer the child's stderr so a failure can report why, bounded so a chatty worker cannot grow it without limit. */
function collect(child: ChildProcess): () => string {
  let buf = "";
  child.stderr?.on("data", (d: Buffer) => {
    buf = (buf + d.toString()).slice(-64 * 1024);
  });
  return () => buf;
}
