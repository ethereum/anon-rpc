// §9.1 — forwarded fetch-init entries.

import type { PlainValue } from "./spec-types.js";
import { copyPlainValue } from "./plain-value.js";

/** The fetch init members §9.1 models; every other own key is forwarded. */
export const MODELED_INIT_KEYS: ReadonlySet<string> = new Set(["method", "headers", "body", "redirect", "signal"]);

/**
 * §9.1: every own enumerable string-keyed init entry §9.1 does not model,
 * copied as a plain value; undefined when there are none. One that is not
 * plain throws a TypeError — dropping it would lose an option without anyone
 * noticing.
 *
 * Call it synchronously inside `fetch`, before any await: §9.1 copies when
 * fetch is called, so a host mutating the options afterwards cannot change the
 * call. A wrapper that awaits anything first (a worker still booting, a body
 * being read) has already broken that.
 */
export function copyForwardedEntries(init: object | undefined): { [key: string]: PlainValue } | undefined {
  if (!init) return undefined;
  let out: { [key: string]: PlainValue } | undefined;
  for (const key of Object.keys(init)) {
    if (MODELED_INIT_KEYS.has(key)) continue;
    out ??= {};
    // defineProperty, so a "__proto__" key stays an own property.
    Object.defineProperty(out, key, {
      value: copyPlainValue((init as Record<string, unknown>)[key], `init.${key}`),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}
