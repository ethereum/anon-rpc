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

let renderMd;
async function renderDocMarkdown(slug) {
  if (!renderMd) {
    const highlighter = await createHighlighter({
      themes: ["dracula"],
      langs: ["typescript", "solidity", "bash"],
    });
    const marked = new Marked(
      markedShiki({
        highlight: (code, lang) =>
          highlighter.codeToHtml(code, {
            lang: highlighter.getLoadedLanguages().includes(lang) ? lang : "text",
            theme: "dracula",
            colorReplacements: { "#282a36": "#08060d" },
          }),
      }),
    );
    renderMd = (md) => marked.parse(md);
  }
  const file = DOC_PAGES[slug];
  const md = readFileSync(resolve(import.meta.dirname, file), "utf8");
  let html = await renderMd(md);
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
