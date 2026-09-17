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
import JSON5 from "json5";
import { Marked } from "marked";
import markedShiki from "marked-shiki";
import { createHighlighter } from "shiki";

/**
 * `import data from "…/adopters.json5"`. Vite handles .json natively but treats
 * an unknown extension as a static asset, so this must run before the asset
 * plugin ("pre") and hand back a module instead of a URL.
 */
function json5Modules() {
  return {
    name: "json5",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0];
      if (!file.endsWith(".json5")) return;
      const data = JSON5.parse(readFileSync(file, "utf8"));
      return `export default ${JSON.stringify(data)};`;
    },
  };
}

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
// never disagree about an address or the config a worker expects. The file
// documents its own fields in comments — hence JSON5.
const ADOPTERS_FILE = JSON5.parse(
  readFileSync(resolve(import.meta.dirname, "../../adopters.json5"), "utf8"),
);
const KNOWN_WORKERS = ADOPTERS_FILE.workers;
// The other half of that file: wallets and apps that ship anon-rpc. Empty until
// the first one does, which the /adopters/ page says in as many words.
const WALLETS_AND_APPS = ADOPTERS_FILE.walletsAndApps ?? [];

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
  // `config:` here is the harness's own WorkerInit field (§7.1) — the API name
  // stays put; only the value substituted into it comes from exampleConfig.
  for (const anchor of [`"${base.specifier}"`, `config: ${configLiteral(base.exampleConfig)},`]) {
    if (!template.includes(anchor)) {
      throw new Error(
        `WORKER_PICKER sample no longer matches adopters.json5 entry "${base.id}": ` +
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
      .replace(
        `config: ${configLiteral(base.exampleConfig)},`,
        `config: ${configLiteral(w.exampleConfig)},`,
      );
    const notes = [
      w.note && `<p class="picker-note">${esc(w.note)}</p>`,
      w.exampleConfigNote && `<p class="picker-note warn">${esc(w.exampleConfigNote)}</p>`,
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
  const gh = `<a class="ghost" href="https://github.com/ethereum/anon-rpc/blob/main/${ghPath}" target="_blank" rel="noopener">View on GitHub →</a>`;
  return html.replace(
    /<h1([^>]*)>([\s\S]*?)<\/h1>/,
    (_m, attrs, inner) => `<div class="doc-head"><h1${attrs}>${inner}</h1>${gh}</div>`,
  );
}

// ---------------------------------------------------------------------------
// Shared chrome. Every page shell carries a <!--NAV--> slot rather than its own
// copy of the header: six hand-maintained copies had already drifted (three
// pages linked "Spec" at themselves), and a seventh page would drift again.
// Paths are relative, so the only per-page variable is the depth prefix.
// ---------------------------------------------------------------------------

// The site's page shells: every one carries the shared header, and every one is
// a build input. src/bench/ is deliberately absent from both — it is a dev-only
// harness page (see bench/run.mjs), never built and never navigable.
const PAGES = ["index", "demo", "spec", "wallets", "networks", "adopters"];

// Real pages, in nav order. The two guides are named "… guide" rather than
// "Wallets"/"Networks" because /adopters/ has sections by those names that mean
// the parties, not the documents.
const NAV_ITEMS = [
  { slug: "wallets", label: "Wallet guide" },
  { slug: "networks", label: "Network guide" },
  { slug: "adopters", label: "Adopters" },
  { slug: "spec", label: "Spec" },
];

const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M16 3.5l10 4.2v7.1c0 6.6-4.3 10.6-10 13.2-5.7-2.6-10-6.6-10-13.2V7.7l10-4.2z" stroke="url(#ag)" stroke-width="2" stroke-linejoin="round"/>
          <circle cx="16" cy="14.5" r="3" fill="url(#ag)"/>
          <path d="M16 17.5v5" stroke="url(#ag)" stroke-width="2.2" stroke-linecap="round"/>
          <defs><linearGradient id="ag" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse"><stop stop-color="#b79dff"/><stop offset="1" stop-color="#ff79c6"/></linearGradient></defs>
        </svg>`;

const GH_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.69-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.4-5.25 5.68.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.67.8.56C20.71 21.39 24 17.08 24 12c0-6.35-5.15-11.5-11.5-11.5z"/></svg>`;

/** The site header, identical on every page but for which link is current. */
function renderNav(active) {
  // "index" is the only page at the site root; everything else is one deep.
  const p = active === "index" ? "" : "../";
  const current = (slug) => (slug === active ? ' aria-current="page"' : "");
  const links = NAV_ITEMS.map(
    ({ slug, label }) => `<a href="${p}${slug}/"${current(slug)}>${label}</a>`,
  ).join("\n        ");
  return `<header class="nav">
    <div class="nav-inner">
      <a class="brand" href="${p || "./"}">
        ${BRAND_MARK}
        <span class="brand-name">anon-rpc</span>
      </a>
      <nav class="nav-links">
        ${links}
        <a class="gh" href="https://github.com/ethereum/anon-rpc" target="_blank" rel="noopener" aria-label="View source on GitHub" title="View source on GitHub">
          ${GH_MARK}
        </a>
        <a class="btn sm nav-cta" href="${p}demo/"${current("demo")}>Live demo →</a>
      </nav>
    </div>
  </header>`;
}

// ---------------------------------------------------------------------------
// The adopters page (/adopters/): the same adopters.json5, rendered as a
// directory rather than a code sample. Static HTML built here — the page has no
// runtime JavaScript, so it is as fast and as scrapeable as the list is short.
// ---------------------------------------------------------------------------

const ETHERSCAN = "https://etherscan.io/address/";

// "tor-js — fetch over Tor" carries two things the card wants apart: the name a
// worker calls itself, and its one-line tagline. The dropdown label is the only
// place both are written, so it stays the single source and is split here.
function splitLabel(label) {
  const [name, ...rest] = label.split(/\s+—\s+/);
  return { name, tagline: rest.join(" — ") };
}

function workerCard(w) {
  const { name, tagline } = splitLabel(w.label);
  // A worker that does not anonymize must say so at a glance, not only in the
  // paragraph underneath it: this page is read by people shopping for one.
  const reference = w.kind === "reference";
  const tag = reference
    ? `<span class="tag tag-muted">Reference worker</span>`
    : `<span class="tag">Anonymizing network</span>`;
  const heading = w.url
    ? `<a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(name)}</a>`
    : esc(name);
  // Labelled "Example config" rather than "Config": §7.1 config is opaque to
  // the harness and defined by the network, so what is listed here is one set
  // of values known to work, not the shape a wallet is obliged to send.
  const config = w.exampleConfig
    ? `<div class="entry-row"><dt>Example config</dt><dd><pre class="entry-config">${esc(
        JSON.stringify(w.exampleConfig, null, 2),
      )}</pre></dd></div>`
    : "";
  const configNote = w.exampleConfigNote
    ? `<p class="entry-warn">${esc(w.exampleConfigNote)}</p>`
    : "";
  return `<article class="card entry" id="worker-${esc(w.id)}">
  <div class="entry-head"><h3>${heading}</h3>${tag}</div>
  ${tagline ? `<p class="entry-tagline">${esc(tagline)}</p>` : ""}
  <p>${esc(w.note ?? "")}</p>
  ${configNote}
  <dl class="entry-meta">
    <div class="entry-row"><dt>Specifier</dt><dd><a class="mono addr" href="${ETHERSCAN}${esc(
      w.specifier,
    )}#readContract" target="_blank" rel="noopener">${esc(w.specifier)}</a></dd></div>
    ${config}
  </dl>
  <div class="entry-links">
    <a class="ghost" href="../demo/?worker=${esc(w.id)}">Try it in the demo →</a>
    <a class="ghost" href="../wallets/">Use it in code →</a>
  </div>
</article>`;
}

function adopterCard(a) {
  const ships = (a.workers ?? [])
    .map((id) => KNOWN_WORKERS.find((w) => w.id === id))
    .filter(Boolean)
    .map((w) => `<a href="#worker-${esc(w.id)}">${esc(splitLabel(w.label).name)}</a>`)
    .join(", ");
  const heading = a.url
    ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)}</a>`
    : esc(a.label);
  return `<article class="card entry" id="adopter-${esc(a.id)}">
  <div class="entry-head"><h3>${heading}</h3><span class="tag tag-muted">${esc(
    a.kind === "app" ? "Application" : "Wallet",
  )}</span></div>
  <p>${esc(a.note ?? "")}</p>
  ${ships ? `<dl class="entry-meta"><div class="entry-row"><dt>Ships</dt><dd>${ships}</dd></div></dl>` : ""}
</article>`;
}

function renderAdopters() {
  const workers = KNOWN_WORKERS.map(workerCard).join("\n");
  const walletsAndApps = WALLETS_AND_APPS;
  // An empty list is stated plainly rather than dressed up: anon-rpc is a
  // proposed standard, and pretending otherwise would be the wrong first
  // impression for the people this page is asking to be the first entry.
  const adopterBody = walletsAndApps.length
    ? `<div class="entries">${walletsAndApps.map(adopterCard).join("\n")}</div>`
    : `<div class="card empty">
  <p><strong>No shipping integrations listed yet.</strong> anon-rpc is a proposed standard, and
  the first wallet or application to ship it belongs here.</p>
  <p>If you are building one, the integration is one class and one package —
  <a href="../wallets/">read the guide</a>, then add yourself below.</p>
</div>`;
  return `<section class="section" id="networks">
  <div class="section-head">
    <div class="eyebrow">Publishing a worker</div>
    <h2>Anonymizing networks</h2>
    <p>Each entry is live on Ethereum mainnet. The specifier address is everything a wallet needs —
    paste it into a harness and the pinned client code is fetched, hash-verified and sandboxed for you.</p>
  </div>
  <div class="entries">
${workers}
  </div>
</section>

<section class="section" id="hosts">
  <div class="section-head">
    <div class="eyebrow">Running a worker</div>
    <h2>Wallets &amp; applications</h2>
    <p>The hosts (§2) that consume an anonymized <code>fetch</code> in production.</p>
  </div>
  ${adopterBody}
</section>

<section class="section" id="become">
  <div class="section-head">
    <div class="eyebrow">Haven't integrated yet</div>
    <h2>Become an adopter</h2>
  </div>
  <div class="tools">
    <a class="card tool-card" href="../networks/">
      <h3>I run an anonymizing network <span class="arrow">→</span></h3>
      <p>Ship your client as a hash-pinned worker and point a specifier contract at it: the
      capability API, the bundle, and hosting the bytes. Every wallet using anon-rpc can then
      reach you by address alone.</p>
    </a>
    <a class="card tool-card" href="../wallets/">
      <h3>I build a wallet or app <span class="arrow">→</span></h3>
      <p>Construct a worker from a specifier address and get back an anonymized <code>fetch</code>.
      One class, one package — and switching networks later is a change of address.</p>
    </a>
  </div>
</section>

<section class="section" id="get-listed">
  <div class="section-head">
    <div class="eyebrow">Already integrated</div>
    <h2>Get listed on this page</h2>
  </div>
  <p class="listing-foot">
    <a class="btn secondary" href="https://github.com/ethereum/anon-rpc/edit/main/adopters.json5" target="_blank" rel="noopener">Edit adopters.json5 on GitHub →</a>
  </p>
</section>`;
}

/** Which page a shell belongs to, from its path: src/foo/index.html → "foo". */
function slugOf(filename) {
  const m = filename.replace(/\\/g, "/").match(/([^/]+)\/index\.html$/);
  return m && m[1] !== "src" ? m[1] : "index";
}

function sharedNav() {
  return {
    name: "inject-nav",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const slug = slugOf(ctx.filename);
        // Pages outside the site proper (the dev-only bench harness) get no
        // chrome; a page shell that IS one and lost its slot is a build error.
        if (!PAGES.includes(slug)) return;
        if (!html.includes("<!--NAV-->")) {
          throw new Error(`${ctx.filename} has no <!--NAV--> slot for the shared header`);
        }
        return html.replace("<!--NAV-->", () => renderNav(slug));
      },
    },
  };
}

/** The demo, packaged as an extension: name, bytes, and where it comes from. */
const EXTENSION_ZIP = "anon-rpc-demo-extension.zip";
const EXTENSION_SRC = resolve(import.meta.dirname, `../demo-extension/dist/${EXTENSION_ZIP}`);

/**
 * Serves the demo extension's archive and injects the download card.
 *
 * The archive is built by the `demo-extension` workspace, which comes before
 * this one in the root build. Vite is told to emit it rather than being pointed
 * at `src/public/`: it is a build artifact, and a generated file living in a
 * tracked directory shows up as a dirty tree after every build.
 */
function demoExtension() {
  const read = () => {
    try {
      return readFileSync(EXTENSION_SRC);
    } catch {
      return undefined;
    }
  };

  return {
    name: "demo-extension",

    buildStart() {
      // A build that silently ships a dead download link is worse than a
      // failed one. `vite dev` is exempt: it has no buildStart-time need for
      // the artifact, and the middleware below explains its absence.
      if (this.meta.watchMode) return;
      if (!read()) {
        throw new Error(
          `${EXTENSION_SRC} is missing — run \`npm run build --workspaces\` so the ` +
            "demo-extension workspace builds before the site.",
        );
      }
    },

    generateBundle() {
      const source = read();
      if (source) this.emitFile({ type: "asset", fileName: EXTENSION_ZIP, source });
    },

    configureServer(server) {
      server.middlewares.use(`/${EXTENSION_ZIP}`, (_req, res) => {
        const source = read();
        if (!source) {
          res.statusCode = 404;
          res.end("demo-extension has not been built; run `npm run build -w anon-rpc-demo-extension`");
          return;
        }
        res.setHeader("content-type", "application/zip");
        res.end(source);
      });
    },

    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (slugOf(ctx.filename) !== "demo") return;
        if (!html.includes("<!--EXTENSION_DOWNLOAD-->")) {
          throw new Error(`${ctx.filename} has no <!--EXTENSION_DOWNLOAD--> slot`);
        }
        const bytes = read()?.length;
        const size = bytes ? `${(bytes / 1024).toFixed(0)} KB` : "not built";
        return html.replace("<!--EXTENSION_DOWNLOAD-->", () => renderExtensionCard(size));
      },
    },
  };
}

function renderExtensionCard(size) {
  // Deliberately explicit about the unpacked-install dance. Chrome cannot load
  // a .zip directly and this extension is not in any store, so a download link
  // with no instructions is a dead end for most readers.
  return `<div class="card">
      <h2>Run it as a browser extension</h2>
      <p class="field-note">
        The same demo, packaged for Chrome with
        <a href="https://github.com/ethereum/anon-rpc/tree/main/impl/browser-extension-harness"><code>@anon-rpc/browser-extension-harness</code></a>.
        A service worker owns the harness, an offscreen document holds the
        null-origin sandbox, and the worker stays verified and running between
        popup opens.
      </p>
      <p>
        <a class="btn" href="../${EXTENSION_ZIP}" download>Download extension (${size})</a>
      </p>
      <ol class="field-note install-steps">
        <li>Unzip it — Chrome loads a folder, not an archive.</li>
        <li>Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.</li>
        <li>Choose <strong>Load unpacked</strong> and pick the unzipped folder.</li>
        <li>Open the extension's popup and press <strong>Start watching</strong>.</li>
      </ol>
      <p class="field-note">
        Unsigned and not in the Chrome Web Store: it is a demo of the standard,
        not a product. The source is
        <a href="https://github.com/ethereum/anon-rpc/tree/main/impl/demo-extension">impl/demo-extension</a>.
      </p>
    </div>`;
}

function adoptersPage() {
  return {
    name: "inject-adopters",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        if (!/adopters[\\/]index\.html$/.test(ctx.filename)) return;
        return html.replace("<!--ADOPTERS_HTML-->", () => renderAdopters());
      },
    },
  };
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
  plugins: [json5Modules(), sharedNav(), docPages(), adoptersPage(), demoExtension()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // Same list as the nav, so a new page cannot be built without chrome or
      // given chrome without being built.
      input: Object.fromEntries(
        PAGES.map((slug) => [
          slug,
          resolve(import.meta.dirname, slug === "index" ? "src/index.html" : `src/${slug}/index.html`),
        ]),
      ),
    },
  },
});
