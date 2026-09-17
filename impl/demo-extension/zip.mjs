// A minimal ZIP writer.
//
// Node ships no zip, and this needs exactly one feature — write N files into
// one archive — so it uses `zlib` rather than adding a dependency. `zlib.crc32`
// (Node 22.2+) and `deflateRawSync` are the only pieces of the format that are
// not bookkeeping.
//
// Deliberately deterministic: a fixed timestamp and no extra fields, so the
// same inputs produce byte-identical output. The site serves this archive as a
// build artifact, and an archive whose bytes churn on every build would show up
// as a spurious diff in every deploy.

import { crc32, deflateRawSync } from "node:zlib";

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (1980 - 1980) << 9 | (1 << 5) | 1; // 1980-01-01, the epoch of the format
const METHOD_DEFLATE = 8;

/**
 * Build a ZIP archive.
 *
 * @param {{ name: string, data: Buffer | Uint8Array | string }[]} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.includes(0x5c)) {
      // A backslash in a zip entry name is a path separator on exactly one
      // platform and a literal character everywhere else, which is how
      // archives end up with files called `a\b`.
      throw new Error(`zip entry name must use forward slashes: ${entry.name}`);
    }
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Stored rather than deflated when compression made it bigger, which
    // happens for tiny or already-compressed files.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : METHOD_DEFLATE;
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0o644 << 16, 38); // external attributes: unix mode
    central.writeUInt32LE(offset, 42); // offset of the local header
    name.copy(central, 46);

    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // directory offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, directory, end]);
}
