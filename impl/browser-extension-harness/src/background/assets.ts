// Checking that the extension actually contains the assets this build expects.
//
// The two packaged files are copied into the extension by hand, while the code
// that talks to them is imported from node_modules and rebuilt on every
// `npm install`. So the two can drift, and the drift is silent: an offscreen
// document from an older copy answers on the same port, ignores whatever it
// does not recognise, and `worker.ready` never settles because nothing on that
// path has a timeout.
//
// The version stamp in the asset path is what turns that into a detectable
// state — a stale copy leaves the expected path empty rather than occupied by
// something subtly wrong. This file is the part that says so out loud, because
// "the file is not there" is only a good error if it names which file and how
// it got that way.

import { chromeApi } from "../chrome-types.js";

// Substituted by build.mjs. Declared as IDENTIFIERS so esbuild's `define`
// rewrites them; written as string literals they would ship verbatim, and the
// failure would be the very confusion this file exists to prevent.
declare const __ASSET_PATH__: string;
declare const __PKG_VERSION__: string;

/**
 * Where this build's packaged assets live inside the extension, e.g.
 * `anon-rpc/0.3.1-1a2b3c4d`. The stamp is the package version plus a hash of
 * the asset bytes, so it changes exactly when the assets do.
 */
export const ASSET_PATH = typeof __ASSET_PATH__ === "string" ? __ASSET_PATH__ : "anon-rpc/dev";

/** The package version this build came from. */
export const PKG_VERSION = typeof __PKG_VERSION__ === "string" ? __PKG_VERSION__ : "dev";

const INSTALL_HINT =
  "rm -rf <extension>/anon-rpc && " +
  "cp -r node_modules/@anon-rpc/browser-extension-harness/dist/static/anon-rpc <extension>/";

/**
 * Fail with a legible error if a packaged asset is not in the extension.
 *
 * Cheap: these are the extension's own resources, read from disk, and only on
 * boot. The alternative is not "slightly faster" — it is a hang.
 */
export async function assertAssetPresent(url: string, what: string): Promise<void> {
  let present: boolean;
  try {
    present = (await fetch(url)).ok;
  } catch {
    present = false;
  }
  if (present) return;
  throw new Error(
    `the packaged anon-rpc ${what} is not in this extension at ${url}. ` +
      `This is @anon-rpc/browser-extension-harness ${PKG_VERSION}, which expects its assets ` +
      `at ${ASSET_PATH}/ — an upgrade re-bundles the code that reads that path but cannot ` +
      `update files you copied, so the copy has to be re-run as part of your build: ${INSTALL_HINT}`,
  );
}

/** Absolute URL of a packaged asset, for this build's asset path. */
export function assetUrl(file: string): string {
  return chromeApi().runtime.getURL(`${ASSET_PATH}/${file}`);
}
