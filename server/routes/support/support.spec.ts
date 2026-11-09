/**
 * routes/support/support.spec.ts — the two endpoints, over real HTTP.
 *
 * WHAT THESE TESTS ARE FOR
 * The units underneath (redaction, report, zip, bundle) are tested on their
 * own. What is left, and what can only be tested here, is the WIRING:
 *
 *  - the preview answers even when the database is down, because "the
 *    database is down" is the single most likely reason somebody is filing
 *    a report in the first place;
 *  - nothing is written to disk by the preview — the user has not consented
 *    to anything yet;
 *  - the bundle endpoint writes exactly one file, where it says it did;
 *  - attachments arrive as explicit base64 payloads, never as paths the
 *    server goes and reads for itself;
 *  - a marker seeded into the environment does not come back out of the
 *    HTTP response.
 *
 * `mssql` is mocked for the usual reason — importing server.ts pulls in the
 * whole database layer — and COIN_LOG_DIR / COIN_SUPPORT_OUTPUT_DIR are
 * pointed at throwaway directories so no test touches the developer's real
 * log or their real Desktop.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

/**
 * Both directories have to be set BEFORE server.ts (and through it the
 * logger) is imported, and ES imports are hoisted above ordinary statements.
 * vi.hoisted is the supported way to run setup ahead of them.
 */
const dirs = vi.hoisted(() => {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const osMod = require('node:os') as typeof import('node:os');
  const pathMod = require('node:path') as typeof import('node:path');

  const logDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'coin-support-logs-'));
  const outDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'coin-support-out-'));
  process.env['COIN_LOG_DIR'] = logDir;
  process.env['COIN_SUPPORT_OUTPUT_DIR'] = outDir;
  return { logDir, outDir };
});

import { app } from '../../server';
import { mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';

beforeEach(() => {
  resetMssqlMock();
  for (const name of fs.readdirSync(dirs.outDir)) {
    fs.rmSync(path.join(dirs.outDir, name), { force: true });
  }
});

afterAll(() => {
  fs.rmSync(dirs.logDir, { recursive: true, force: true });
  fs.rmSync(dirs.outDir, { recursive: true, force: true });
});

/** Pull one entry out of an archive written by support/zip.ts. */
function readEntry(zip: Buffer, name: string): string | null {
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLen = zip.readUInt16LE(offset + 26);
    const extraLen = zip.readUInt16LE(offset + 28);
    const entryName = zip.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (entryName === name) {
      return zlib.inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)).toString('utf8');
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

/** The single zip the bundle endpoint just wrote. */
function onlyWrittenBundle(): Buffer {
  const files = fs.readdirSync(dirs.outDir);
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dirs.outDir, files[0]));
}

// POST /api/support/preview

describe('POST /api/support/preview', () => {
  it('returns a report with the environment in it', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [{ coins: 12, photos: 30, transactions: 4 }] });

    const res = await request(app).post('/api/support/preview').send({});

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('### Environment');
    expect(res.body.markdown).toContain(process.version);
  });

  it('includes the collection counts when the database answers', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [{ coins: 2140, photos: 2140, transactions: 88 }] });

    const res = await request(app).post('/api/support/preview').send({});

    expect(res.body.markdown).toContain('2140');
    expect(res.body.markdown).toContain('88');
  });

  /**
   * THE MOST IMPORTANT TEST IN THIS FILE. If the report needed a working
   * database, it would be unavailable in precisely the situation it exists
   * for. The packaging design calls a support channel that silently fails
   * worse than no support channel at all; one that loudly fails is no
   * better.
   */
  it('still produces a report when the database is unreachable', async () => {
    mockRequest.query.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).post('/api/support/preview').send({});

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('### Environment');
    expect(res.body.markdown).toMatch(/could not be read/i);
  });

  it('carries the recent in-app errors the frontend sent', async () => {
    const res = await request(app).post('/api/support/preview').send({
      clientErrors: [{ timestamp: '2026-11-08T17:00:00.000Z', message: 'saving the coin failed' }]
    });

    expect(res.body.markdown).toContain('saving the coin failed');
  });

  it('carries the user\'s own description', async () => {
    const res = await request(app).post('/api/support/preview').send({
      userDescription: 'It crashes when I click Export.'
    });

    expect(res.body.markdown).toContain('It crashes when I click Export.');
  });

  it('lists the attachments it was told about, by name and size only', async () => {
    const res = await request(app).post('/api/support/preview').send({
      attachments: [{ name: 'GoldCoins.QIF', bytes: 4096 }]
    });

    expect(res.body.markdown).toContain('GoldCoins.QIF');
  });

  it('returns the receipt alongside the text', async () => {
    const res = await request(app).post('/api/support/preview').send({
      userDescription: 'my password=hunter2 is in here'
    });

    expect(res.body.markdown).not.toContain('hunter2');
    expect(Array.isArray(res.body.receipt)).toBe(true);
    expect(JSON.stringify(res.body.receipt)).not.toContain('hunter2');
  });

  /** Nothing has been consented to yet, so nothing may exist on disk yet. */
  it('writes nothing to disk', async () => {
    await request(app).post('/api/support/preview').send({});
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });

  it('tells the frontend where the zip will go and how big attachments may be', async () => {
    const res = await request(app).post('/api/support/preview').send({});

    expect(typeof res.body.outputDirectory).toBe('string');
    expect(res.body.outputDirectory.length).toBeGreaterThan(0);
    expect(res.body.limits.maxFileBytes).toBeGreaterThan(0);
    expect(res.body.limits.maxFiles).toBeGreaterThan(0);
  });

  it('reports whether a real repository has been configured', async () => {
    const res = await request(app).post('/api/support/preview').send({});
    expect(typeof res.body.repositoryUrl).toBe('string');
    expect(typeof res.body.repositoryConfigured).toBe('boolean');
  });
});

// POST /api/support/bundle

describe('POST /api/support/bundle', () => {
  it('writes one zip and says exactly where', async () => {
    const res = await request(app)
      .post('/api/support/bundle')
      .send({ markdown: '## Problem report\n\nit broke\n' });

    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/^coin-inventory-problem-report-.*\.zip$/);
    expect(res.body.directory).toBe(dirs.outDir);
    expect(fs.existsSync(res.body.path)).toBe(true);
    expect(res.body.bytes).toBeGreaterThan(0);
  });

  it('the zip contains the approved report', async () => {
    await request(app).post('/api/support/bundle').send({ markdown: 'it broke at step four' });
    expect(readEntry(onlyWrittenBundle(), 'report.md')).toContain('it broke at step four');
  });

  it('includes an attachment the user explicitly sent, byte for byte', async () => {
    const qif = '!Type:Invst\nNmy holdings\n^\n';

    await request(app).post('/api/support/bundle').send({
      markdown: 'see attached',
      attachments: [{ name: 'mine.qif', contentBase64: Buffer.from(qif).toString('base64') }]
    });

    expect(readEntry(onlyWrittenBundle(), 'attachments/mine.qif')).toBe(qif);
  });

  /**
   * The server must never be handed a PATH and told to go and read it. That
   * would be an arbitrary-file-read reachable from any local process (the
   * same class of problem flagged for
   * /api/images/file), and it would also let a bug attach a file the user
   * never picked. Content comes over the wire or not at all.
   */
  it('refuses an attachment that names a path, even when it also has content', async () => {
    // STRENGTHENED AFTER A MUTATION SURVIVED. The first version of this test
    // sent `{ name, path }` with no content, so removing the path guard
    // entirely still produced a 400 — from the "no content" check further
    // down. It proved nothing about the guard it was written for. Supplying
    // valid content as well makes the path the ONLY reason to refuse.
    const res = await request(app).post('/api/support/bundle').send({
      markdown: 'x',
      attachments: [
        {
          name: 'secrets.txt',
          path: 'C:\\Windows\\win.ini',
          contentBase64: Buffer.from('harmless').toString('base64')
        }
      ]
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path/i);
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });

  it('still refuses an attachment with no content at all', async () => {
    const res = await request(app).post('/api/support/bundle').send({
      markdown: 'x',
      attachments: [{ name: 'empty.txt' }]
    });

    expect(res.status).toBe(400);
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });

  it('refuses a request with no report text', async () => {
    const res = await request(app).post('/api/support/bundle').send({});
    expect(res.status).toBe(400);
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });

  it('reports attachments it had to turn away instead of dropping them quietly', async () => {
    const tooBig = Buffer.alloc(11 * 1024 * 1024).toString('base64');

    const res = await request(app).post('/api/support/bundle').send({
      markdown: 'x',
      attachments: [{ name: 'huge.bin', contentBase64: tooBig }]
    });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0].name).toBe('huge.bin');
  });

  it('re-redacts text the user typed into the preview', async () => {
    const res = await request(app).post('/api/support/bundle').send({
      markdown: `I was in ${process.env['USERPROFILE'] ?? os.homedir()}\\Pictures`
    });

    expect(res.status).toBe(200);
    const report = readEntry(onlyWrittenBundle(), 'report.md')!;
    const username = process.env['USERNAME'] ?? os.userInfo().username;
    expect(report.toLowerCase()).not.toContain(username.toLowerCase());
  });

  it('lists what went into the archive', async () => {
    const res = await request(app).post('/api/support/bundle').send({ markdown: 'x' });
    expect(res.body.entries).toContain('report.md');
    expect(res.body.entries).toContain('logs/recent.log');
    expect(res.body.entries).toContain('redaction-receipt.txt');
  });
});

// Canary, over HTTP

describe('canary: a marker in the environment does not reach the response', () => {
  const CANARY = 'CANARYLEAK7391';
  const ORIGINAL_USER = process.env['USERNAME'];
  const ORIGINAL_MACHINE = process.env['COMPUTERNAME'];

  beforeEach(() => {
    process.env['USERNAME'] = `user${CANARY}`;
    process.env['COMPUTERNAME'] = `pc${CANARY}`;
  });

  afterAll(() => {
    if (ORIGINAL_USER === undefined) delete process.env['USERNAME'];
    else process.env['USERNAME'] = ORIGINAL_USER;
    if (ORIGINAL_MACHINE === undefined) delete process.env['COMPUTERNAME'];
    else process.env['COMPUTERNAME'] = ORIGINAL_MACHINE;
  });

  it('is absent from the preview response', async () => {
    const res = await request(app).post('/api/support/preview').send({
      userDescription: `it broke in C:\\Users\\user${CANARY}\\Pictures`,
      clientErrors: [
        { timestamp: '2026-11-08T17:00:00.000Z', message: `failed for user${CANARY}` }
      ],
      attachments: [{ name: `user${CANARY}-holdings.qif`, bytes: 10 }]
    });

    expect(JSON.stringify(res.body)).not.toContain(CANARY);
  });

  it('is absent from the bundle response and from the archive bytes', async () => {
    const res = await request(app).post('/api/support/bundle').send({
      markdown: `crashed at \\\\pc${CANARY}\\photos while signed in as user${CANARY}`,
      attachments: [
        { name: `user${CANARY}-notes.txt`, contentBase64: Buffer.from('abc').toString('base64') }
      ]
    });

    expect(JSON.stringify(res.body)).not.toContain(CANARY);
    expect(onlyWrittenBundle().toString('latin1')).not.toContain(CANARY);
  });
});
