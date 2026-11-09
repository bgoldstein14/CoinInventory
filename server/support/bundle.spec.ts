/**
 * support/bundle.spec.ts — the zip that lands on the Desktop.
 *
 * WHAT IS BEING PINNED DOWN HERE
 *  - Where the file goes. "The Desktop" is not a fixed path on a modern
 *    Windows install: OneDrive Known Folder Move relocates it, and getting
 *    this wrong means telling the user to drag a file that is not there.
 *  - What is in the zip, and in particular that the report and the log tail
 *    are redacted AGAIN on the way in. The preview was redacted; the user
 *    then edited it. Re-running the pass is cheap, idempotent on text that
 *    is already clean, and closes the hole where a user pastes a path into
 *    the box and it goes out verbatim.
 *  - That their OWN attachments are byte-for-byte untouched. Redacting a QIF
 *    would corrupt the one artefact needed to reproduce the bug.
 *    This is the deliberate asymmetry at the heart of the feature, and the
 *    blunt warning in the UI is what pays for it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  ATTACHMENT_LIMITS,
  bundleFileName,
  buildBundleZip,
  resolveDesktopDirectory,
  validateAttachments,
  writeBundleToDesktop
} from './bundle';

const IDENTITY = {
  username: 'devuser',
  machineName: 'MYSERVER',
  homeDir: 'C:\\Users\\devuser'
};

/**
 * Pull one entry back out of an archive produced by support/zip.ts.
 *
 * Walks the local headers rather than the central directory, which is enough
 * for a handful of entries and keeps the helper short. support/zip.spec.ts is
 * where the format itself is verified, including against Windows' own reader.
 */
function readEntry(zip: Buffer, name: string): Buffer | null {
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const entryName = zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;

    if (entryName === name) {
      return zlib.inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize));
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

function entryNames(zip: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    names.push(zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8'));
    offset = offset + 30 + nameLen + extraLen + compressedSize;
  }
  return names;
}

// Where it goes

describe('resolveDesktopDirectory', () => {
  it('uses the Desktop under the user profile when it is there', () => {
    const exists = (p: string) => p === 'C:\\Users\\dev\\Desktop';
    expect(resolveDesktopDirectory({ USERPROFILE: 'C:\\Users\\dev' }, 'C:\\Users\\dev', exists))
      .toBe('C:\\Users\\dev\\Desktop');
  });

  /**
   * OneDrive Known Folder Move. On a machine where it is on, the real
   * Desktop is C:\Users\dev\OneDrive\Desktop and the profile one either does
   * not exist or is a stub. Telling a user to look on their Desktop for a
   * file that is in the other Desktop is the kind of failure that ends a
   * support conversation before it starts.
   */
  it('falls back to the OneDrive Desktop when the profile one is absent', () => {
    const exists = (p: string) => p === 'C:\\Users\\dev\\OneDrive\\Desktop';
    expect(
      resolveDesktopDirectory(
        { USERPROFILE: 'C:\\Users\\dev', OneDrive: 'C:\\Users\\dev\\OneDrive' },
        'C:\\Users\\dev',
        exists
      )
    ).toBe('C:\\Users\\dev\\OneDrive\\Desktop');
  });

  it('falls back to the home folder when there is no Desktop at all', () => {
    expect(resolveDesktopDirectory({}, '/home/dev', () => false)).toBe('/home/dev');
  });
});

describe('bundleFileName', () => {
  it('is dated, sortable and unmistakably ours', () => {
    const name = bundleFileName(new Date('2026-11-08T18:04:05.000Z'));
    expect(name).toBe('coin-inventory-problem-report-2026-11-08-180405.zip');
  });

  /**
   * Two reports a few seconds apart is a completely ordinary thing to do —
   * a question comes back, the user reports again. A minute-resolution
   * name would make the second file silently overwrite the first.
   */
  it('two reports seconds apart do not collide', () => {
    const a = bundleFileName(new Date('2026-11-08T18:04:00.000Z'));
    const b = bundleFileName(new Date('2026-11-08T18:04:01.000Z'));
    expect(a).not.toBe(b);
  });
});

// Attachment gate

describe('validateAttachments', () => {
  it('accepts an ordinary QIF', () => {
    const result = validateAttachments([{ name: 'GoldCoins.QIF', content: Buffer.alloc(2048) }]);
    expect(result.accepted.map(a => a.name)).toEqual(['GoldCoins.QIF']);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a file over the per-file cap, and says why', () => {
    const result = validateAttachments([
      { name: 'huge.xlsx', content: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1) }
    ]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].name).toBe('huge.xlsx');
    expect(result.rejected[0].reason).toMatch(/too large/i);
  });

  it('stops accepting once the total cap is reached, keeping the earlier files', () => {
    // Three files at the per-file limit: 10 + 10 fits inside the 25 MB
    // total, the third does not. Each file is individually legal, so this
    // exercises the TOTAL rule rather than the per-file one.
    const atLimit = () => Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes);
    const result = validateAttachments([
      { name: 'a.qif', content: atLimit() },
      { name: 'b.qif', content: atLimit() },
      { name: 'c.qif', content: atLimit() }
    ]);

    expect(result.accepted.map(a => a.name)).toEqual(['a.qif', 'b.qif']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe('c.qif');
    expect(result.rejected[0].reason).toMatch(/total/i);
  });

  it('rejects more files than the count cap', () => {
    const many = Array.from({ length: ATTACHMENT_LIMITS.maxFiles + 3 }, (_, i) => ({
      name: `f${i}.qif`,
      content: Buffer.from('x')
    }));
    const result = validateAttachments(many);
    expect(result.accepted).toHaveLength(ATTACHMENT_LIMITS.maxFiles);
    expect(result.rejected).toHaveLength(3);
  });

  it('nothing is attached when nothing was chosen — there is no default', () => {
    expect(validateAttachments([]).accepted).toEqual([]);
  });
});

// The archive

describe('buildBundleZip', () => {
  const base = {
    markdown: '## Problem report\n\nit broke\n',
    logTail: ['[2026-11-08T17:00:00.000Z] [INFO] GET /api/coins'],
    attachments: [],
    identity: IDENTITY
  };

  it('contains the report, the log tail and the receipt', () => {
    const { zip } = buildBundleZip(base);
    const names = entryNames(zip);

    expect(names).toContain('report.md');
    expect(names).toContain('logs/recent.log');
    expect(names).toContain('redaction-receipt.txt');
  });

  it('writes the report text the user approved', () => {
    const { zip } = buildBundleZip(base);
    expect(readEntry(zip, 'report.md')!.toString('utf8')).toContain('it broke');
  });

  /**
   * THE HOLE THIS CLOSES: the preview was redacted, and then the user typed
   * into it. "I was looking at C:\Users\devuser\Pictures when it crashed" is
   * a completely natural thing for somebody to add, and without this second
   * pass it would go straight into the public zip.
   */
  it('re-redacts the report text, because the user edited it after the preview', () => {
    const { zip } = buildBundleZip({
      ...base,
      markdown: 'I was looking at C:\\Users\\devuser\\Pictures when it crashed'
    });

    const report = readEntry(zip, 'report.md')!.toString('utf8');
    expect(report).not.toContain('devuser');
    expect(report).toContain('C:\\Users\\<USER>\\Pictures');
  });

  it('redacts the log tail that goes into the zip', () => {
    const { zip } = buildBundleZip({
      ...base,
      logTail: ['Connecting to SQL Server at MYSERVER\\SQLEXPRESS/CoinInventory']
    });

    const log = readEntry(zip, 'logs/recent.log')!.toString('utf8');
    expect(log).not.toContain('MYSERVER');
    expect(log).toContain('<MACHINE>\\SQLEXPRESS');
  });

  /**
   * The deliberate asymmetry. The user's own file is NOT redacted: a QIF with
   * `<USER>` substituted into it is a corrupt QIF, and the whole point of
   * attaching it is that it can be replayed. The protection here is
   * consent, not scrubbing — see the warning in the UI.
   */
  it('leaves the user\'s own attachments byte-for-byte alone', () => {
    const qif = Buffer.from('!Type:Invst\nNdevuser holdings\n^\n', 'utf8');
    const { zip } = buildBundleZip({ ...base, attachments: [{ name: 'mine.qif', content: qif }] });

    expect(readEntry(zip, 'attachments/mine.qif')!.equals(qif)).toBe(true);
  });

  it('puts attachments in their own folder so they cannot shadow the report', () => {
    const { zip } = buildBundleZip({
      ...base,
      attachments: [{ name: 'report.md', content: Buffer.from('not the report') }]
    });

    expect(readEntry(zip, 'report.md')!.toString('utf8')).toContain('it broke');
    expect(readEntry(zip, 'attachments/report.md')!.toString('utf8')).toBe('not the report');
  });

  it('flattens a path in an attachment name — only the file name survives', () => {
    const { zip } = buildBundleZip({
      ...base,
      attachments: [{ name: '..\\..\\Windows\\evil.dll', content: Buffer.from('x') }]
    });
    expect(entryNames(zip)).toContain('attachments/evil.dll');
  });

  /**
   * An attachment's NAME is redacted even though its CONTENT is not — a file
   * called `devuser-holdings.qif` would otherwise publish the username in
   * the archive listing, where it is stored uncompressed and plainly visible.
   *
   * The placeholder is bracketed differently inside file names because `<`
   * and `>` are ILLEGAL in Windows file names: an entry called
   * `<USER>-holdings.qif` produces an archive that Explorer refuses to
   * extract. That is a real bug, found by the canary below, not a style
   * preference.
   */
  it('redacts an attachment file name, using Windows-legal brackets', () => {
    const { zip } = buildBundleZip({
      ...base,
      attachments: [{ name: 'devuser-holdings.qif', content: Buffer.from('x') }]
    });

    const names = entryNames(zip);
    expect(names).toContain('attachments/(USER)-holdings.qif');
    expect(names.join('|')).not.toContain('devuser');
    expect(names.join('|')).not.toContain('<');
  });

  it('reports the entry names it wrote, for the UI to show', () => {
    const { entries } = buildBundleZip({
      ...base,
      attachments: [{ name: 'mine.qif', content: Buffer.from('x') }]
    });
    expect(entries).toContain('attachments/mine.qif');
  });

  it('writes a receipt that names no values', () => {
    const { zip } = buildBundleZip({
      ...base,
      markdown: 'Password=hunter2; and C:\\Users\\devuser\\x'
    });

    const receipt = readEntry(zip, 'redaction-receipt.txt')!.toString('utf8');
    expect(receipt).not.toContain('hunter2');
    expect(receipt).not.toContain('devuser');
    expect(receipt).toContain('<USER>');
  });
});

// Actually writing it

describe('writeBundleToDesktop', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-desktop-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a real file and reports where it put it', () => {
    const result = writeBundleToDesktop(dir, Buffer.from('PK fake'), new Date('2026-11-08T18:04:00Z'));

    expect(fs.existsSync(result.path)).toBe(true);
    expect(path.dirname(result.path)).toBe(dir);
    expect(result.bytes).toBe(7);
    expect(result.fileName).toMatch(/^coin-inventory-problem-report-/);
  });

  it('creates the directory if it is somehow missing', () => {
    const nested = path.join(dir, 'Desktop');
    const result = writeBundleToDesktop(nested, Buffer.from('x'), new Date());
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

// Canary, end to end through the zip

describe('canary: a marker does not reach the zip', () => {
  const CANARY = 'CANARYLEAK7391';

  it('is gone from report.md, recent.log and the receipt', () => {
    const identity = { username: `user${CANARY}`, machineName: `pc${CANARY}` };

    const { zip } = buildBundleZip({
      markdown: `crashed in C:\\Users\\user${CANARY}\\Pictures`,
      logTail: [
        `Connecting to SQL Server at pc${CANARY}\\SQLEXPRESS/CoinInventory`,
        `Password=${CANARY};`
      ],
      attachments: [],
      identity
    });

    expect(readEntry(zip, 'report.md')!.toString('utf8')).not.toContain(CANARY);
    expect(readEntry(zip, 'logs/recent.log')!.toString('utf8')).not.toContain(CANARY);
    expect(readEntry(zip, 'redaction-receipt.txt')!.toString('utf8')).not.toContain(CANARY);
  });

  it('is absent from the raw archive bytes entirely', () => {
    // The strongest form of the assertion: not just "not in the entries we
    // thought to check", but "not anywhere in the file". Entry NAMES are
    // stored uncompressed in the headers, so a marker in a file name would
    // be caught here even though it survives DEFLATE unrecognisably.
    const identity = { username: `user${CANARY}`, machineName: 'PC' };
    const { zip } = buildBundleZip({
      markdown: 'nothing to see',
      logTail: [],
      attachments: [{ name: `user${CANARY}-notes.txt`, content: Buffer.from('abc') }],
      identity
    });

    expect(zip.toString('latin1')).not.toContain(CANARY);
  });
});
