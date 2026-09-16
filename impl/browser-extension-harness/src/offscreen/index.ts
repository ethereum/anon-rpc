// The offscreen-document entry. Import this from your own offscreen document
// if you already have one; otherwise ship the packaged anon-rpc-offscreen.html,
// which does nothing but call mountOffscreenHost().
export { mountOffscreenHost } from "./mount.js";
export type { MountOptions } from "./mount.js";
