// The slice of the extension API this package touches, typed locally.
//
// Deliberately not `@types/chrome`: that is a 4MB dependency describing every
// extension API, and this package uses four of them. Declaring the shapes here
// keeps the surface visible — if something new is used, it has to be added
// below, which is a review-sized change rather than an invisible one — and lets
// the package build for hosts that are not Chrome.

export type RuntimePort = {
  name: string;
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (msg: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
};

export type OffscreenApi = {
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument?(): Promise<void>;
  hasDocument?(): Promise<boolean>;
};

export type RuntimeApi = {
  getURL(path: string): string;
  connect(opts: { name: string }): RuntimePort;
  onConnect: { addListener(fn: (port: RuntimePort) => void): void };
};

export type ChromeLike = {
  runtime?: RuntimeApi;
  offscreen?: OffscreenApi;
};

/** The extension API, or a clear error rather than `undefined is not an object`. */
export function chromeApi(): ChromeLike & { runtime: RuntimeApi } {
  const c = (globalThis as unknown as { chrome?: ChromeLike }).chrome;
  if (!c?.runtime) {
    throw new Error(
      "@anon-rpc/browser-extension-harness must run in an extension context (chrome.runtime is missing)",
    );
  }
  return c as ChromeLike & { runtime: RuntimeApi };
}
