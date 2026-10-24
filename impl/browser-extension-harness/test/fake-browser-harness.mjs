// Stands in for @anon-rpc/browser-harness in workers.test.mjs: PageWorker's
// inner worker, recording each fetch's init exactly as it was handed over.
export const calls = [];

export class AnonRpcWorker {
  constructor() {
    this.ready = Promise.resolve();
  }
  async fetch(_input, init) {
    calls.push(JSON.parse(JSON.stringify(init ?? {})));
    return new Response("ok");
  }
  acceptLog() {
    return new Promise(() => {});
  }
  close() {}
}
