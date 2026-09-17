// The script behind the packaged anon-rpc/offscreen.html. One line of runtime
// behaviour; it exists so an extension that needs nothing custom can copy two
// files instead of writing a document of its own.
import { mountOffscreenHost } from "./mount.js";

mountOffscreenHost();
