export { AnonRpcWorker, RpcError } from "./AnonRpcWorker.js";
export type { NodeWorkerInit, IsolateLimits } from "./AnonRpcWorker.js";
export { isolateThreadPath } from "./isolation.js";
export type { AddressPolicy } from "./address-policy.js";
export type * from "../spec-types.js";

// Not exported: confinement.ts and the Go launcher. They are the SUPERSEDED
// Landlock strategy — kept in the tree because their findings are why this one
// exists, and reachable through probe/run.mjs, but no longer a thing the
// harness API can be asked for. See README.md.
