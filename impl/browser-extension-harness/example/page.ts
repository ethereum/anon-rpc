// The example page's script: ask the service worker for an anonymized call and
// render whatever comes back. `#out` is what the e2e reads.
declare const chrome: {
  runtime: { sendMessage(msg: unknown): Promise<unknown> };
};

const out = document.getElementById("out")!;

async function go(): Promise<void> {
  out.textContent = "pending";
  try {
    // The specifier under test comes from the URL, so the e2e can point the
    // same page at a different worker without a second extension.
    const q = new URLSearchParams(location.search);
    const address = q.get("address") ?? undefined;
    const iframeUrl = q.get("iframeUrl") ?? undefined;
    // ?logs=1 reads what the worker logged instead of making a call, so the
    // e2e can inspect the §13 path through the same page.
    if (q.has("logs")) {
      const rows = await chrome.runtime.sendMessage({ type: "anon-logs", address, iframeUrl });
      out.textContent = JSON.stringify(rows);
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "anon-fetch",
      address,
      iframeUrl,
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    });
    out.textContent = JSON.stringify(res);
  } catch (e) {
    out.textContent = JSON.stringify({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
}

document.getElementById("go")!.addEventListener("click", () => void go());
// Auto-run so the e2e need not synthesise a click before the page is wired.
void go();
