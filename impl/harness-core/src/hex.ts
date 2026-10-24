// Its own module so plain-value.ts can use it without importing the §4 code,
// and keccak with it (see build.mjs).
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
