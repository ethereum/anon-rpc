// Version-invariant guard, run as part of `npm test` (and therefore the
// prepublishOnly gate and CI):
//
//   1. package version >= the spec version — the package must never LOOK
//      behind the spec it implements. (Not ==: a package release without a
//      spec change bumps the package past the spec.)
//   2. The README's "Implements the anon-rpc specification version **X**"
//      claim matches SPEC.md exactly — the statement cannot go stale.

import { readFile } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url);
const fail = (msg) => {
  console.error(`❌ spec-version check: ${msg}`);
  process.exit(1);
};

const pkg = JSON.parse(await readFile(here("./package.json"), "utf8"));
const spec = await readFile(here("../../SPEC.md"), "utf8");
const readme = await readFile(here("./README.md"), "utf8");

const specVersion = spec.match(/^- \*\*Version:\*\* (\d+\.\d+\.\d+)$/m)?.[1];
if (!specVersion) fail("could not parse the Version header from SPEC.md");

const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

if (cmp(pkg.version, specVersion) < 0) {
  fail(`package ${pkg.version} < spec ${specVersion} — bump the package version to at least the spec version`);
}

const claimed = readme.match(/specification.*?\n?version \*\*(\d+\.\d+\.\d+)\*\*/)?.[1];
if (!claimed) fail("README does not state the implemented spec version");
if (claimed !== specVersion) {
  fail(`README claims spec ${claimed} but SPEC.md is ${specVersion} — update the README (and implement the delta!)`);
}

console.log(`✓ spec-version check: package ${pkg.version} >= spec ${specVersion}, README claim matches`);
