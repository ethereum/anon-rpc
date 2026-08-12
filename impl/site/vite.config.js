// Vite build for the GitHub Pages site (landing + demo + spec, multi-page).
//
// Note: unlike raw esbuild, Vite does NOT read tsconfig `paths`, so the
// typecheck-only mapping of @anon-rpc/browser-harness to the harness SOURCE
// (tsconfig.json) cannot leak into the bundle — the bundler resolves the real
// package exports: the BUILT dist/host.js with its define-injected iframe/
// worker-runtime sources. The site smoke test still verifies the built bundle
// contains no unresolved defines, whatever the bundler.

import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Marked } from "marked";
import markedShiki from "marked-shiki";
import { createHighlighter } from "shiki";

// Markdown pages host the repo's docs, rendered at build time (and live in
// `vite dev`) into the <!--DOC_HTML--> slot of each page shell. Code fences
// are syntax-highlighted with Shiki at build time — inline-styled spans, no
// runtime JS. Dracula's pink/purple/cyan sits naturally on the site's violet
// palette; its background is remapped to the site's code-block black.
const DOC_PAGES = {
  spec: "../../SPEC.md",
  wallets: "../../docs/integrate-wallet.md",
  networks: "../../docs/integrate-network.md",
};

// Known worker deployments, shared with the demo (src/demo/main.ts) so the two
// never disagree about an address or the config a worker expects.
const KNOWN_WORKERS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../known-workers.json"), "utf8"),
).workers;

/** A config object as it would be written in the sample: JS literal, 2-space. */
function configLiteral(config) {
  if (config === undefined) return "undefined";
  return JSON.stringify(config, null, 2)
    // Quoted keys are noise in a TypeScript sample; ours are all identifiers.
    .replace(/^(\s*)"([A-Za-z_$][\w$]*)":/gm, "$1$2:")
    // Re-indent to sit inside the object literal in the snippet.
    .replace(/\n/g, "\n  ");
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The wallet guide's quick start is one code sample per known worker, behind a
// row of tabs. The markdown carries a single static sample (what GitHub readers
// see); here it becomes the template for the rest, substituting the address and
// config of the worker it already names. Anchoring on that worker's own values
// means a drifted sample fails the build rather than silently publishing a
// stale address.
const PICKER_RE = /<!--WORKER_PICKER:START-->([\s\S]*?)<!--WORKER_PICKER:END-->/;

function renderWorkerPicker(templateMd) {
  const base = KNOWN_WORKERS[0];
  const fence = templateMd.match(/```ts\n([\s\S]*?)```/);
  if (!fence) throw new Error("WORKER_PICKER region has no ```ts code sample");
  const template = fence[1];
  for (const anchor of [`"${base.specifier}"`, `config: ${configLiteral(base.config)},`]) {
    if (!template.includes(anchor)) {
      throw new Error(
        `WORKER_PICKER sample no longer matches known-workers.json entry "${base.id}": ` +
          `expected to find ${JSON.stringify(anchor)}. Update the sample or the JSON.`,
      );
    }
  }

  // The first worker in the file is the tab that opens, and the one the
  // markdown's static sample shows — GitHub and the site agree on the default.
  const tabs = KNOWN_WORKERS.map(
    (w, i) =>
      `<button type="button" class="picker-tab" role="tab" id="worker-tab-${esc(w.id)}"` +
      ` aria-controls="worker-panel-${esc(w.id)}" aria-selected="${i === 0}"` +
      ` tabindex="${i === 0 ? 0 : -1}" data-worker="${esc(w.id)}">${esc(w.id)}</button>`,
  ).join("");

  const panels = KNOWN_WORKERS.map((w, i) => {
    const code = template
      .replace(`"${base.specifier}"`, `"${w.specifier}"`)
      .replace(`config: ${configLiteral(base.config)},`, `config: ${configLiteral(w.config)},`);
    const notes = [
      w.note && `<p class="picker-note">${esc(w.note)}</p>`,
      w.configNote && `<p class="picker-note warn">${esc(w.configNote)}</p>`,
    ]
      .filter(Boolean)
      .join("");
    // Notes lead, so what this worker is (and isn't) is read before the code.
    // Only the first panel renders visible, so the sample is still there with
    // JavaScript disabled.
    return (
      `<div class="picker-panel" role="tabpanel" id="worker-panel-${esc(w.id)}"` +
      ` aria-labelledby="worker-tab-${esc(w.id)}" data-worker="${esc(w.id)}"${i === 0 ? "" : " hidden"}>` +
      `${notes}${highlight(code, "typescript")}</div>`
    );
  }).join("");

  return `<div class="picker" id="worker-picker">
<div class="picker-tabs" role="tablist" aria-label="Known workers">${tabs}</div>
${panels}
</div>
<script>
(function () {
  var tabs = [].slice.call(document.querySelectorAll("#worker-picker .picker-tab"));
  var panels = [].slice.call(document.querySelectorAll("#worker-picker .picker-panel"));
  function select(id, focus) {
    tabs.forEach(function (t) {
      var on = t.dataset.worker === id;
      t.setAttribute("aria-selected", on);
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    panels.forEach(function (p) { p.hidden = p.dataset.worker !== id; });
  }
  tabs.forEach(function (t) {
    t.addEventListener("click", function () { select(t.dataset.worker); });
  });
  // Arrow keys move between tabs, as a tablist is expected to.
  document.querySelector("#worker-picker .picker-tabs").addEventListener("keydown", function (e) {
    var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var i = tabs.findIndex(function (t) { return t.getAttribute("aria-selected") === "true"; });
    select(tabs[(i + step + tabs.length) % tabs.length].dataset.worker, true);
  });
})();
</script>`;
}

let renderMd;
let highlight;
async function renderDocMarkdown(slug) {
  if (!renderMd) {
    const highlighter = await createHighlighter({
      themes: ["dracula"],
      langs: ["typescript", "solidity", "bash"],
    });
    highlight = (code, lang) =>
      highlighter.codeToHtml(code, {
        lang: highlighter.getLoadedLanguages().includes(lang) ? lang : "text",
        theme: "dracula",
        colorReplacements: { "#282a36": "#08060d" },
      });
    const marked = new Marked(markedShiki({ highlight }));
    renderMd = (md) => marked.parse(md);
  }
  const file = DOC_PAGES[slug];
  const md = readFileSync(resolve(import.meta.dirname, file), "utf8");
  let html = await renderMd(md);
  // The marker comments survive rendering, so the region can be swapped for the
  // interactive picker here — built from the raw markdown sample above.
  const region = md.match(PICKER_RE);
  if (region) {
    const widget = renderWorkerPicker(region[1]);
    html = html.replace(PICKER_RE, () => widget);
  }
  // Cross-doc links: the repo markdown links its siblings by file path; on
  // the site those live at the doc slugs.
  html = html
    .replaceAll('href="integrate-wallet.md"', 'href="../wallets/"')
    .replaceAll('href="integrate-network.md"', 'href="../networks/"')
    .replaceAll('href="../SPEC.md"', 'href="../spec/"');
  // Put the GitHub link on the title line: wrap the document's <h1> in a flex
  // row with the button, which flexbox centers at any viewport/font size.
  const ghPath = file.replace("../../", "");
  const gh = `<a class="ghost" href="https://github.com/privacy-ethereum/anon-rpc/blob/main/${ghPath}" target="_blank" rel="noopener">View on GitHub →</a>`;
  return html.replace(
    /<h1([^>]*)>([\s\S]*?)<\/h1>/,
    (_m, attrs, inner) => `<div class="doc-head"><h1${attrs}>${inner}</h1>${gh}</div>`,
  );
}

function docPages() {
  return {
    name: "inject-doc-markdown",
    transformIndexHtml: {
      order: "pre",
      async handler(html, ctx) {
        const sep = ctx.filename.includes("\\") ? "\\" : "/";
        const slug = Object.keys(DOC_PAGES).find((s) =>
          ctx.filename.endsWith(`${s}${sep}index.html`),
        );
        if (!slug) return;
        const doc = await renderDocMarkdown(slug);
        // Replacement via callback: rendered code can contain `$`, which a
        // string replacement would interpret as a substitution pattern.
        return html.replace("<!--DOC_HTML-->", () => doc);
      },
    },
  };
}

export default defineConfig({
  root: "src",
  base: "./", // relative URLs: works at any Pages mount path
  plugins: [docPages()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/index.html"),
        demo: resolve(import.meta.dirname, "src/demo/index.html"),
        spec: resolve(import.meta.dirname, "src/spec/index.html"),
        wallets: resolve(import.meta.dirname, "src/wallets/index.html"),
        networks: resolve(import.meta.dirname, "src/networks/index.html"),
      },
    },
  },
});
