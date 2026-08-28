// The repo's adopters.json5 is imported directly by the demo (src/demo/main.ts)
// and turned into a module at build time by the json5Modules() plugin in
// vite.config.js. TypeScript can parse .json (resolveJsonModule) but not JSON5,
// so the module's shape is declared here instead of inferred.
//
// The demo re-asserts the entry type it needs (`KnownWorker`), which is where
// the real shape is documented; the file's own comments explain the fields.
declare module "*.json5" {
  const value: { workers: unknown[]; walletsAndApps: unknown[] };
  export default value;
}
