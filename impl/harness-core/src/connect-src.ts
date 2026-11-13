// WorkerInit.connectSrc: where a browser harness's worker may connect.
//
// Each entry becomes a CSP source expression on the worker's iframe, so one
// that carries whitespace, ";" or "," would add expressions or whole
// directives the host did not list. Those are refused rather than escaped.

/** Copy `connectSrc`, or throw TypeError if it is not a list of single source expressions. */
export function copyConnectSrc(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("connectSrc must be an array of CSP source expressions");
  return value.map((entry, i) => {
    if (typeof entry !== "string" || !/^[^\s;,]+$/.test(entry)) {
      throw new TypeError(`connectSrc[${i}] is not a single CSP source expression: ${JSON.stringify(entry)}`);
    }
    return entry;
  });
}

/**
 * The policy a worker runs under when the host set `connectSrc`: it connects
 * only to the listed sources, and loads scripts only from `blob:` and `data:`
 * (how the runtime and bundle are loaded), so `importScripts` cannot reach the
 * network either. Eval and WebAssembly stay allowed; they reach nothing.
 */
export function workerCsp(connectSrc: string[]): string {
  return [
    "default-src 'none'",
    "script-src blob: data: 'unsafe-eval' 'wasm-unsafe-eval'",
    "worker-src blob:",
    `connect-src ${connectSrc.length ? connectSrc.join(" ") : "'none'"}`,
  ].join("; ");
}
