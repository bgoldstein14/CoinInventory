/**
 * The three support endpoints over HTTP; the redaction and report modules
 * have their own tests. Checks the wiring: preview works with the database
 * down and writes nothing; the write endpoint produces plain files and returns
 * real and redacted paths; config reports whether a real repository is set;
 * and a seeded marker never leaks. Counts come from the in-memory database;
 * log and output directories are temp folders.
 */

import { describe, it, expect, afterEach, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Both directories must be set before server.ts (and the logger) is imported;
 * vi.hoisted runs this ahead of the hoisted imports.
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

import {
  insertCoin,
  rebuildTestDatabase,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';
// Seeds lines into the temp log directory that the endpoint reads.
import { logInfo } from '../../logger';

/** Set by the test that drops a table on purpose. */
let databaseNeedsRebuilding = false;

beforeEach(() => {
  for (const name of fs.readdirSync(dirs.outDir)) {
    fs.rmSync(path.join(dirs.outDir, name), { force: true });
  }
});

afterEach(async () => {
  if (databaseNeedsRebuilding) {
    databaseNeedsRebuilding = false;
    await rebuildTestDatabase();
  }
});

afterAll(() => {
  fs.rmSync(dirs.logDir, { recursive: true, force: true });
  fs.rmSync(dirs.outDir, { recursive: true, force: true });
});

/**
 * The report `.md` the write endpoint produced, picked by name (a log `.txt`
 * is usually written beside it).
 */
function writtenReport(): string {
  const files = fs.readdirSync(dirs.outDir).filter(f => f.endsWith('.md'));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dirs.outDir, files[0]), 'utf8');
}

/** The optional log `.txt`, or null when none was written. */
function writtenLog(): string | null {
  const files = fs.readdirSync(dirs.outDir).filter(f => f.endsWith('.txt'));
  if (files.length === 0) return null;
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(dirs.outDir, files[0]), 'utf8');
}

// GET /api/support/config

/** The dialog needs the repository URL on its first screen. */
describe('GET /api/support/config', () => {
  it('reports where issues are filed and where the file will go', async () => {
    const res = await request(app).get('/api/support/config');

    expect(res.status).toBe(200);
    expect(typeof res.body.repositoryUrl).toBe('string');
    expect(res.body.repositoryUrl.length).toBeGreaterThan(0);
    expect(res.body.outputDirectory).toBe(dirs.outDir);
  });

  /** While SUPPORT_REPO_URL is the placeholder, the dialog must not link to a 404. */
  it('says the repository is NOT configured while the placeholder stands', async () => {
    const original = process.env['SUPPORT_REPO_URL'];
    delete process.env['SUPPORT_REPO_URL'];
    try {
      const res = await request(app).get('/api/support/config');
      expect(res.body.repositoryConfigured).toBe(false);
      expect(res.body.repositoryUrl).toContain('OWNER');
    } finally {
      if (original === undefined) delete process.env['SUPPORT_REPO_URL'];
      else process.env['SUPPORT_REPO_URL'] = original;
    }
  });

  it('says it IS configured once a real repository is set', async () => {
    const original = process.env['SUPPORT_REPO_URL'];
    process.env['SUPPORT_REPO_URL'] = 'https://github.com/someone/coins';
    try {
      const res = await request(app).get('/api/support/config');
      expect(res.body.repositoryConfigured).toBe(true);
      expect(res.body.repositoryUrl).toBe('https://github.com/someone/coins');
    } finally {
      if (original === undefined) delete process.env['SUPPORT_REPO_URL'];
      else process.env['SUPPORT_REPO_URL'] = original;
    }
  });

  it('writes nothing to disk', async () => {
    await request(app).get('/api/support/config');
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });
});

// POST /api/support/preview

describe('POST /api/support/preview', () => {
  it('returns a report with the environment in it', async () => {
    const res = await request(app).post('/api/support/preview').send({});

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('### Environment');
    expect(res.body.markdown).toContain(process.version);
  });

  it('includes the collection counts when the database answers', async () => {
    // Three different counts, so transposed COUNT(*) subqueries would be caught.
    await insertCoin({ CoinId: 'c-1', Denomination: '$1' });
    await insertCoin({ CoinId: 'c-2', Denomination: '$1' });
    await insertCoin({ CoinId: 'c-3', Denomination: '$1' });
    await withTestDb((database) => {
      const image = database.prepare(
        'INSERT INTO CoinImages (CoinId, ImageData, SortOrder) VALUES (?, ?, ?)'
      );
      image.run('c-1', 'data:image/jpeg;base64,AAAA', 0);
      image.run('c-1', 'data:image/jpeg;base64,BBBB', 1);
      database
        .prepare(
          "UPDATE Coins SET SoldDate = '2026-01-01', SoldPrice = 10 WHERE CoinId = 'c-1'"
        )
        .run();
    });

    const res = await request(app).post('/api/support/preview').send({});

    expect(res.body.markdown).toContain('- coins: 3');
    expect(res.body.markdown).toContain('- photos: 2');
    expect(res.body.markdown).toContain('- soldCoins: 1');
  });

  /** The report must work when the database doesn't, since that's often why it's filed. */
  it('still produces a report when the database is unreachable', async () => {
    // A real failure: the Coins table is dropped (rebuilt in afterEach).
    await withTestDb((database) => database.exec('DROP TABLE Coins'));
    databaseNeedsRebuilding = true;

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

  /** The app attaches nothing and the report says so. */
  it('states that the app attached nothing', async () => {
    const res = await request(app).post('/api/support/preview').send({});

    expect(res.body.markdown).toMatch(/attached nothing and uploaded nothing/i);
  });

  it('returns the receipt alongside the text', async () => {
    const res = await request(app).post('/api/support/preview').send({
      userDescription: 'my password=hunter2 is in here'
    });

    expect(res.body.markdown).not.toContain('hunter2');
    expect(Array.isArray(res.body.receipt)).toBe(true);
    expect(JSON.stringify(res.body.receipt)).not.toContain('hunter2');
  });

  /** Unticked means no log content, including the tail in the body. */
  it('leaves the log tail out of the body when the log was not asked for', async () => {
    logInfo('preview marker PREVIEWNOLOG');

    const withLog = await request(app)
      .post('/api/support/preview')
      .send({ includeLog: true });
    const withoutLog = await request(app)
      .post('/api/support/preview')
      .send({ includeLog: false });

    expect(withLog.body.markdown).toContain('preview marker PREVIEWNOLOG');
    expect(withoutLog.body.markdown).not.toContain('preview marker PREVIEWNOLOG');
  });

  /** "Left out by the reporter" and "not available" are different facts. */
  it('says the reporter chose to leave it out, not that none was available', async () => {
    const res = await request(app).post('/api/support/preview').send({ includeLog: false });

    expect(res.body.markdown).toMatch(/not included/i);
    expect(res.body.markdown).not.toMatch(/No log lines were available/i);
  });

  /** Nothing is written before the user confirms. */
  it('writes nothing to disk', async () => {
    await request(app).post('/api/support/preview').send({});
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });
});

// POST /api/support/report

describe('POST /api/support/report', () => {
  it('writes one markdown file and says exactly where', async () => {
    const res = await request(app)
      .post('/api/support/report')
      .send({ markdown: '## Problem report\n\nit broke\n', includeLog: false });

    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/^coin-inventory-problem-report-.*\.md$/);
    expect(res.body.directory).toBe(dirs.outDir);
    expect(fs.existsSync(res.body.path)).toBe(true);
    expect(res.body.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(dirs.outDir)).toHaveLength(1);
  });

  /** A plain file, not an archive. */
  it('the file is plain readable markdown, not a zip', async () => {
    await request(app).post('/api/support/report').send({ markdown: 'it broke at step four' });

    const written = writtenReport();
    expect(written).toContain('it broke at step four');
    expect(written.slice(0, 2)).not.toBe('PK');
  });

  it('refuses a request with no report text', async () => {
    const res = await request(app).post('/api/support/report').send({});
    expect(res.status).toBe(400);
    expect(fs.readdirSync(dirs.outDir)).toEqual([]);
  });

  it('re-redacts the text on the way to disk', async () => {
    const res = await request(app).post('/api/support/report').send({
      markdown: `I was in ${process.env['USERPROFILE'] ?? os.homedir()}\\Pictures`
    });

    expect(res.status).toBe(200);
    const username = process.env['USERNAME'] ?? os.userInfo().username;
    expect(writtenReport().toLowerCase()).not.toContain(username.toLowerCase());
  });

  /**
   * `path` (screen and server log) is real; `redactedPath` (public issue body)
   * must not contain the user name.
   */
  it('returns a real path for the screen and a redacted one for the issue', async () => {
    const res = await request(app).post('/api/support/report').send({ markdown: 'x' });

    const username = process.env['USERNAME'] ?? os.userInfo().username;

    expect(res.body.path).toBe(path.join(dirs.outDir, res.body.fileName));
    expect(res.body.redactedPath).toContain(res.body.fileName);
    expect(res.body.redactedPath.toLowerCase()).not.toContain(username.toLowerCase());
  });

  it('returns the receipt for what it took out', async () => {
    const res = await request(app).post('/api/support/report').send({
      markdown: 'Password=hunter2;'
    });

    expect(Array.isArray(res.body.receipt)).toBe(true);
    expect(JSON.stringify(res.body.receipt)).not.toContain('hunter2');
  });

  /** An `attachments` array is ignored and nothing extra is written. */
  it('ignores an attachments array — there is nowhere for a file to go', async () => {
    const res = await request(app).post('/api/support/report').send({
      markdown: 'see attached',
      includeLog: false,
      attachments: [
        { name: 'mine.qif', contentBase64: Buffer.from('!Type:Invst\n').toString('base64') }
      ]
    });

    expect(res.status).toBe(200);
    expect(fs.readdirSync(dirs.outDir)).toHaveLength(1);
    expect(writtenReport()).not.toContain('!Type:Invst');
  });
});

// The log file — "Include recent log"

/**
 * The optional redacted log file: ticked writes a second file, unticked writes
 * nothing extra and removes the tail from the body; both files share one
 * redactor; the issue gets the redacted log path.
 */
describe('POST /api/support/report — the optional log file', () => {
  /** Something recognisable in today's log for the log file to pick up. */
  function seedLog(marker: string): void {
    logInfo(`log marker ${marker}`);
  }

  it('writes a second plain .txt beside the report when asked', async () => {
    seedLog('ticked-case');

    const res = await request(app)
      .post('/api/support/report')
      .send({ markdown: 'it broke', includeLog: true });

    expect(res.status).toBe(200);
    expect(res.body.log).not.toBeNull();
    expect(res.body.log.fileName).toMatch(/^coin-inventory-log-.*\.txt$/);
    expect(fs.existsSync(res.body.log.path)).toBe(true);
    expect(fs.readdirSync(dirs.outDir)).toHaveLength(2);
    expect(writtenLog()).toContain('log marker ticked-case');
  });

  /** Plain text, not an archive. */
  it('the log file is plain readable text, not an archive', async () => {
    seedLog('plain-text-case');
    await request(app).post('/api/support/report').send({ markdown: 'x', includeLog: true });

    const log = writtenLog()!;
    expect(log.slice(0, 2)).not.toBe('PK');
    expect(log).toMatch(/Coin Inventory/);
  });

  /** Both files share one timestamp. */
  it('names both files from the same timestamp', async () => {
    const res = await request(app)
      .post('/api/support/report')
      .send({ markdown: 'x', includeLog: true });

    const stamp = /(\d{4}-\d{2}-\d{2}-\d{6})/;
    expect(res.body.fileName.match(stamp)![1]).toBe(res.body.log.fileName.match(stamp)![1]);
  });

  it('writes NOTHING extra when the box is unticked', async () => {
    seedLog('unticked-case');

    const res = await request(app)
      .post('/api/support/report')
      .send({ markdown: 'it broke', includeLog: false });

    expect(res.status).toBe(200);
    expect(res.body.log).toBeNull();
    expect(fs.readdirSync(dirs.outDir)).toHaveLength(1);
    expect(writtenLog()).toBeNull();
  });

  /** Real log path for the screen, redacted one for the issue. */
  it('returns a real log path for the screen and a redacted one for the issue', async () => {
    const res = await request(app)
      .post('/api/support/report')
      .send({ markdown: 'x', includeLog: true });

    const username = process.env['USERNAME'] ?? os.userInfo().username;

    expect(res.body.log.path).toBe(path.join(dirs.outDir, res.body.log.fileName));
    expect(res.body.log.redactedPath).toContain(res.body.log.fileName);
    expect(res.body.log.redactedPath.toLowerCase()).not.toContain(username.toLowerCase());
  });

  /**
   * The shared redactor end to end. `alice` and `bob` aren't this machine's
   * user, so independent redactors could number them differently; they are
   * mentioned in different orders in the report and the log.
   */
  it('redacts both files with ONE redactor, so a path means the same in each', async () => {
    logInfo('later saw C:\\Users\\bob\\Pictures and C:\\Users\\alice\\Pictures');

    const res = await request(app).post('/api/support/report').send({
      markdown: 'first saw C:\\Users\\alice\\Pictures then C:\\Users\\bob\\Pictures',
      includeLog: true
    });

    expect(res.status).toBe(200);
    const report = writtenReport();
    const log = writtenLog()!;

    // The same aliases in both files.
    const reportAlice = /Users\\(<USER\d*>)\\Pictures then/.exec(report)![1];
    const reportBob = /then C:\\Users\\(<USER\d*>)\\Pictures/.exec(report)![1];
    const logBob = /saw C:\\Users\\(<USER\d*>)\\Pictures and/.exec(log)![1];
    const logAlice = /and C:\\Users\\(<USER\d*>)\\Pictures/.exec(log)![1];

    expect(reportAlice).not.toBe(reportBob);
    expect(logAlice).toBe(reportAlice);
    expect(logBob).toBe(reportBob);
    expect(log).not.toContain('alice');
    expect(log).not.toContain('bob');
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
      ]
    });

    expect(JSON.stringify(res.body)).not.toContain(CANARY);
  });

  /**
   * `path` is excluded: it's the real local path shown only to the user.
   * `redactedPath` is checked separately.
   */
  it('is absent from the file on disk', async () => {
    await request(app).post('/api/support/report').send({
      markdown: `crashed at \\\\pc${CANARY}\\photos while signed in as user${CANARY}`
    });

    expect(writtenReport()).not.toContain(CANARY);
  });

  it('is absent from the path that the dialog puts in the public issue', async () => {
    const res = await request(app).post('/api/support/report').send({
      markdown: `signed in as user${CANARY}`
    });

    expect(res.body.redactedPath).not.toContain(CANARY);
    expect(JSON.stringify(res.body.receipt)).not.toContain(CANARY);
  });

  /**
   * The log file is offered as the safe alternative to app.log, so it gets its
   * own canary: the marker is in the user name, machine name, a path, and the
   * log itself.
   */
  it('is absent from the log file the user is invited to attach', async () => {
    logInfo(
      `rendered C:\\Users\\user${CANARY}\\Pictures\\coin.jpg on \\\\pc${CANARY}\\share ` +
      `for user${CANARY}`
    );

    const res = await request(app).post('/api/support/report').send({
      markdown: 'it broke',
      includeLog: true
    });

    expect(res.status).toBe(200);
    const log = writtenLog();
    expect(log).not.toBeNull();
    // It really read the seeded line.
    expect(log).toContain('<USER>');
    expect(log).not.toContain(CANARY);
  });

  it('is absent from the log file\u2019s path in the public issue body', async () => {
    const res = await request(app).post('/api/support/report').send({
      markdown: 'it broke',
      includeLog: true
    });

    expect(res.body.log.redactedPath).not.toContain(CANARY);
    expect(JSON.stringify(res.body.receipt)).not.toContain(CANARY);
  });
});
