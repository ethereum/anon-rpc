// prelude.guest.js is loaded as text (see build.mjs) and evaluated inside the
// QuickJS isolate, so to this program it is a string, not a module.
//
// Named `guest-source` rather than `prelude.guest.d.ts` on purpose: a .d.ts
// sitting beside a .js with the same basename is treated as THAT file's
// declaration and has to be a module itself, which defeats the wildcard.
declare module "*.guest.js" {
  const source: string;
  export default source;
}
