/**
 * support/zip.spec.ts
 *
 * WHY THERE IS A HAND-WRITTEN ZIP WRITER AT ALL
 * The bundle has to be a .zip because the user is going to drag it onto a
 * GitHub issue, and GitHub rejects most other extensions. Node has `zlib`
 * (raw DEFLATE) but no archiver, so the choices were: add a dependency, or
 * write ~120 lines of well-documented binary layout.
 *
 * A dependency lost on two counts. `esbuild.exe` is blocked by group policy
 * on this machine and `npm install` is already the most fragile step in this
 * environment, so adding a package to the SERVER tree — which currently has
 * five runtime dependencies — to write a container format that has not
 * changed since 1993 is a poor trade. The format is also the easiest thing in
 * this whole feature to test honestly, which is what the last test here does:
 * it hands the bytes to Windows' own ZIP reader. A zip that only our code can
 * open would be worthless.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED
 * No ZIP64, no encryption, no directory entries, no multi-disk. The bundle is
 * a handful of files well under 4 GB. Anything more is scope that cannot be
 * justified by a support report.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { createZip, safeZipEntryName } from './zip';

/** Little-endian readers, so the assertions below read like the spec. */
const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

describe('safeZipEntryName', () => {
  /**
   * Entry names come from user-chosen attachments, so they are untrusted
   * input. A name of `..\..\Windows\System32\evil.dll` in an archive is the
   * classic "zip slip": it does nothing to us, but it turns the bundle the
   * user is about to publish into a malicious archive for whoever extracts
   * it. Normalising at write time is the cheap place to stop that.
   */
  it('strips directory traversal', () => {
    expect(safeZipEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(safeZipEntryName('..\\..\\Windows\\System32\\x.dll')).toBe('Windows/System32/x.dll');
  });

  it('strips a drive letter and a leading separator', () => {
    expect(safeZipEntryName('C:\\Users\\dev\\notes.qif')).toBe('Users/dev/notes.qif');
    expect(safeZipEntryName('/var/log/app.log')).toBe('var/log/app.log');
  });

  it('normalises backslashes — the zip spec says forward slashes', () => {
    expect(safeZipEntryName('attachments\\statement.qif')).toBe('attachments/statement.qif');
  });

  it('never returns an empty name', () => {
    expect(safeZipEntryName('')).toBe('file');
    expect(safeZipEntryName('../..')).toBe('file');
  });
});

describe('createZip — the container', () => {
  it('starts with a local file header and ends with an end-of-central-directory record', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }]);

    expect(u32(zip, 0)).toBe(LOCAL_SIG);
    const eocdOffset = zip.length - 22;
    expect(u32(zip, eocdOffset)).toBe(EOCD_SIG);
  });

  it('records the right number of entries in both places the spec asks for', () => {
    const zip = createZip([
      { name: 'a.txt', data: 'one' },
      { name: 'b.txt', data: 'two' },
      { name: 'c.txt', data: 'three' }
    ]);
    const eocd = zip.length - 22;

    expect(u16(zip, eocd + 8)).toBe(3);   // entries on this disk
    expect(u16(zip, eocd + 10)).toBe(3);  // entries total
  });

  it('points the central directory at a real central-directory signature', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }]);
    const eocd = zip.length - 22;
    const cdOffset = u32(zip, eocd + 16);

    expect(u32(zip, cdOffset)).toBe(CENTRAL_SIG);
  });

  it('round-trips the payload through raw inflate', () => {
    const payload = 'the quick brown fox '.repeat(50);
    const zip = createZip([{ name: 'a.txt', data: payload }]);

    const nameLen = u16(zip, 26);
    const extraLen = u16(zip, 28);
    const compressedSize = u32(zip, 18);
    const dataStart = 30 + nameLen + extraLen;
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);

    expect(zlib.inflateRawSync(compressed).toString('utf8')).toBe(payload);
  });

  it('stores the uncompressed size and a non-zero CRC', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }]);
    expect(u32(zip, 22)).toBe(5);
    expect(u32(zip, 14)).not.toBe(0);
  });

  it('writes the UTF-8 name flag so non-ASCII file names survive', () => {
    const zip = createZip([{ name: 'rapport-é.txt', data: 'x' }]);
    expect(u16(zip, 6) & 0x0800).toBe(0x0800);
  });

  it('handles an empty file without producing a corrupt entry', () => {
    const zip = createZip([{ name: 'empty.txt', data: '' }]);
    expect(u32(zip, 22)).toBe(0);              // uncompressed size
    expect(u32(zip, 0)).toBe(LOCAL_SIG);
  });

  it('handles an empty archive', () => {
    const zip = createZip([]);
    expect(zip).toHaveLength(22);
    expect(u32(zip, 0)).toBe(EOCD_SIG);
  });

  it('accepts binary data unchanged', () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 0, 0, 10, 13]);
    const zip = createZip([{ name: 'b.bin', data: bytes }]);

    const nameLen = u16(zip, 26);
    const dataStart = 30 + nameLen + u16(zip, 28);
    const compressed = zip.subarray(dataStart, dataStart + u32(zip, 18));

    expect(zlib.inflateRawSync(compressed).equals(bytes)).toBe(true);
  });

  it('normalises unsafe entry names on the way in', () => {
    const zip = createZip([{ name: '../../secret.txt', data: 'x' }]);
    const nameLen = u16(zip, 26);
    expect(zip.subarray(30, 30 + nameLen).toString('utf8')).toBe('secret.txt');
  });
});

// The only test that proves the format is actually right

describe('a real ZIP reader can open it', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-zip-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Windows' own System.IO.Compression.ZipFile — i.e. what the user's
   * Explorer, and GitHub, will use. Asserting against our own parser would
   * only prove the writer and the reader share a misunderstanding.
   *
   * Skipped off Windows; this application is Windows-only (packaging design
   * a declared non-goal) and there is nothing to gain from a second implementation
   * of the check for a platform that will never run it.
   */
  const itOnWindows = process.platform === 'win32' ? it : it.skip;

  itOnWindows('extracts to the right files with the right contents', () => {
    const zip = createZip([
      { name: 'report.md', data: '# Problem report\n\nIt broke.\n' },
      { name: 'logs/recent.log', data: 'line one\nline two\n' },
      { name: 'attachments/statement.qif', data: '!Type:Invst\n^\n' }
    ]);

    const zipPath = path.join(dir, 'bundle.zip');
    const outDir = path.join(dir, 'out');
    fs.writeFileSync(zipPath, zip);

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
          `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}','${outDir}')`
      ],
      { stdio: 'pipe' }
    );

    expect(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'))
      .toBe('# Problem report\n\nIt broke.\n');
    expect(fs.readFileSync(path.join(outDir, 'logs', 'recent.log'), 'utf8'))
      .toBe('line one\nline two\n');
    expect(fs.readFileSync(path.join(outDir, 'attachments', 'statement.qif'), 'utf8'))
      .toBe('!Type:Invst\n^\n');
  }, 30_000);
});
