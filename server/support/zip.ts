/**
 * support/zip.ts — a minimal ZIP writer.
 *
 * WHY WRITE ONE
 * The support bundle must be a .zip: the user drags it onto a GitHub issue,
 * and GitHub's attachment allow-list rejects most other extensions. Node
 * ships `zlib` (raw DEFLATE) but no archiver, and the server tree keeps its
 * runtime dependency list deliberately tiny. This is ~120 lines of a
 * container format that has not changed since 1993, and zip.spec.ts verifies
 * the bytes against Windows' own ZIP reader.
 *
 * WHAT IS NOT SUPPORTED, ON PURPOSE
 * No ZIP64 (so no member and no archive over 4 GB), no encryption, no
 * explicit directory entries, no multi-disk, no data descriptors. A support
 * bundle is a report, a log tail and a few user files; the cap in
 * routes/support keeps it far below any of those limits.
 *
 * LAYOUT, FOR WHOEVER READS THIS NEXT
 *   [local header + deflated bytes]  per entry
 *   [central directory header]       per entry
 *   [end of central directory]       once
 *
 * Every integer is little-endian. The offsets in the code below are the
 * offsets from the PKWARE APPNOTE, kept as named constants rather than magic
 * numbers because an off-by-two here produces an archive that *looks* fine
 * and fails to open.
 */

import zlib from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive. Normalised by safeZipEntryName. */
  name: string;
  data: Buffer | string;
}

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;

/** 2.0 — the minimum version that understands DEFLATE. */
const VERSION_NEEDED = 20;

/**
 * Bit 11: "the file name is UTF-8".
 *
 * Without it, readers fall back to IBM Code Page 437 and a user whose coin
 * notes are called `rapport-é.qif` gets mojibake in the archive listing.
 */
const FLAG_UTF8_NAMES = 0x0800;

const METHOD_DEFLATE = 8;

/**
 * CRC-32 lookup table (IEEE polynomial, reflected: 0xEDB88320).
 *
 * Built once at module load. Every entry needs a CRC in two places — the
 * local header and the central directory — and a wrong one makes extraction
 * fail with "the archive is corrupt" rather than with anything diagnosable.
 */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Make an entry name safe to put in an archive.
 *
 * THE BUG THIS PREVENTS: "zip slip"
 * Entry names here are partly derived from files the USER picked, so they
 * are untrusted. An entry called `..\..\Windows\System32\x.dll` does nothing
 * to us — we are writing, not extracting — but it would turn the bundle the
 * user is about to attach to a PUBLIC issue into a malicious archive for
 * whoever downloads it. Stripping drive letters, leading separators and
 * every `..` segment at write time costs nothing and closes it.
 *
 * Also normalises `\` to `/`, which the ZIP specification requires and which
 * Windows-sourced names will otherwise violate.
 */
export function safeZipEntryName(name: string): string {
  const normalised = name
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:/, '')       // drive letter
    .replace(/^\/+/, '');            // leading separator -> relative

  const segments = normalised
    .split('/')
    .filter(segment => segment.length > 0 && segment !== '.' && segment !== '..');

  // Never return '' — an archive entry with no name is unreadable, and the
  // obvious inputs ('..', 'C:\') reduce to exactly that.
  return segments.length > 0 ? segments.join('/') : 'file';
}

/**
 * MS-DOS packed date and time, which is what ZIP stores.
 *
 * Two-second resolution and a 1980 epoch, both inherited from DOS. Clamped at
 * 1980 because a date before the epoch encodes as a negative year and some
 * readers reject the entry outright.
 */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time:
      (when.getHours() << 11) |
      (when.getMinutes() << 5) |
      (Math.floor(when.getSeconds() / 2)),
    date:
      ((year - 1980) << 9) |
      ((when.getMonth() + 1) << 5) |
      when.getDate()
  };
}

interface PreparedEntry {
  nameBytes: Buffer;
  compressed: Buffer;
  crc: number;
  uncompressedSize: number;
  localOffset: number;
}

/**
 * Build a ZIP archive in memory.
 *
 * In memory rather than streamed because the bundle is explicitly capped
 * (see routes/support) at a size that comfortably fits — and because a
 * streamed writer would need the data-descriptor variant of the format,
 * which is more code and more ways to be subtly wrong.
 */
export function createZip(entries: readonly ZipEntry[], when: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(when);

  const prepared: PreparedEntry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(safeZipEntryName(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = zlib.deflateRawSync(data);

    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8_NAMES, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);     // no extra field

    prepared.push({
      nameBytes,
      compressed,
      crc: crc32(data),
      uncompressedSize: data.length,
      localOffset: offset
    });

    chunks.push(header, nameBytes, compressed);
    offset += header.length + nameBytes.length + compressed.length;
  }

  // ---- Central directory -------------------------------------------------
  const centralStart = offset;
  for (const entry of prepared) {
    const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
    header.writeUInt32LE(CENTRAL_DIR_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);   // version made by
    header.writeUInt16LE(VERSION_NEEDED, 6);   // version needed
    header.writeUInt16LE(FLAG_UTF8_NAMES, 8);
    header.writeUInt16LE(METHOD_DEFLATE, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30);   // extra length
    header.writeUInt16LE(0, 32);   // comment length
    header.writeUInt16LE(0, 34);   // disk number start
    header.writeUInt16LE(0, 36);   // internal attributes
    header.writeUInt32LE(0, 38);   // external attributes
    header.writeUInt32LE(entry.localOffset, 42);

    chunks.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }

  // ---- End of central directory -----------------------------------------
  const eocd = Buffer.alloc(EOCD_BYTES);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);                          // this disk
  eocd.writeUInt16LE(0, 6);                          // disk with central dir
  eocd.writeUInt16LE(prepared.length, 8);            // entries on this disk
  eocd.writeUInt16LE(prepared.length, 10);           // entries total
  eocd.writeUInt32LE(offset - centralStart, 12);     // central dir size
  eocd.writeUInt32LE(centralStart, 16);              // central dir offset
  eocd.writeUInt16LE(0, 20);                         // comment length
  chunks.push(eocd);

  return Buffer.concat(chunks);
}
