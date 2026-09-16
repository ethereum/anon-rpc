// Starting the worker_thread that owns the QuickJS isolate.
//
// Compare confinement.ts, which this replaces as the harness's isolation: that
// file spawns a Go launcher which applies a Landlock ruleset and a seccomp
// filter and then execve's node, needs a per-platform binary, and works only on
// Linux 5.13+. This file starts a thread. The boundary moved from the kernel
// into the language, so there is nothing to install, nothing to probe for, and
// nothing to degrade gracefully about.
//
// What is gone with it, and worth being explicit about: there is no grant set
// here. No /etc/ssl, no resolver files, no /proc — because the guest is not a
// process with a filesystem view to restrict. It has no filesystem at all.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Limits applied to the guest. See isolate.ts for how each is enforced. */
export type IsolateLimits = {
  /** Guest heap cap; exceeding it raises `out of memory` in the guest. */
  memoryBytes?: number;
  /**
   * How long guest code may run without yielding before it is interrupted.
   * This is the one `node:vm` has no equivalent for, and the reason a
   * `for(;;){}` in worker code is survivable.
   */
  deadlineMs?: number;
};

/** The script the thread runs. Built by `npm run build`. */
export function isolateThreadPath(): string {
  // dist/host.js and dist/isolate-thread.js are siblings after a build; under
  // a ts-run/dev context HERE is src/host, so fall back to the built file.
  const beside = resolve(HERE, "isolate-thread.js");
  return existsSync(beside) ? beside : resolve(HERE, "../../dist/isolate-thread.js");
}

export type SpawnedIsolate = {
  worker: Worker;
  /** Stop the thread. `terminate` needs no cooperation from the guest. */
  stop(): Promise<void>;
};

/**
 * Start the isolate thread.
 *
 * The environment is EMPTY. It matters less than it did for the process-based
 * path — the guest cannot read `process.env` through any route, since it has no
 * `process` — but the thread itself is harness code that has no use for the
 * host's environment either, and §6 names the host's secrets specifically.
 */
export function spawnIsolate(): SpawnedIsolate {
  const script = isolateThreadPath();
  if (!existsSync(script)) {
    throw new Error(`isolate thread script not found at ${script} — run \`npm run build\``);
  }

  const worker = new Worker(script, {
    env: {},
    // Guest code cannot reach argv or execArgv, but the thread should not be
    // able to inherit an inspector port either: --inspect on the host would
    // otherwise expose a debugger on a thread holding guest data.
    execArgv: [],
    // stdout/stderr are NOT captured. Guest output does not come out this way
    // — `console` in the isolate is bridged to §13 logging — so anything
    // printed here is the harness failing, and hiding that behind a pipe
    // nobody reads costs a diagnostic and buys nothing.
  });
  // The harness owns the worker's lifetime through close(); an un-unref'd
  // thread would keep a host process alive after it stopped caring.
  worker.unref();

  return {
    worker,
    stop: async () => {
      await worker.terminate();
    },
  };
}
