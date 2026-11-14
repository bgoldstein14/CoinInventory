/**
 * routes/support/support.spec.ts — the three endpoints, over real HTTP.
 *
 * WHAT THESE TESTS ARE FOR
 * The units underneath (redaction, report, report-file) are tested on their
 * own. What is left, and what can only be tested here, is the WIRING:
 *
 *  - the preview answers even when the database is down, because "the
 *    database is down" is the single most likely reason somebody is filing
 *    a report in the first place;
 *  - nothing is written to disk by the preview — the user has not consented
 *    to anything yet;
 *  - the write endpoint writes exactly one PLAIN MARKDOWN file, where it says
 *    it did, and tells the caller both the real path (for the screen) and a
 *    redacted one (for the public issue body);
 *  - the config endpoint reports whether a real repository is configured, so
 *    the dialog never renders a link to a 404;
 *  - a marker seeded into the environment does not come back out of the
 *    HTTP response or land in the file.
 *
 * THERE IS NO ZIP AND NO ATTACHMENT ENDPOINT ANY MORE. The archive writer and
 * the base64 upload were deleted: the app cannot upload to GitHub, so with no
 * archive there was nowhere for a staged file to go. The tests that covered
 * them went with them rather than being softened.
 *
 * The collection counts come out of the REAL in-memory SQLite database (the
 * only database access the whole feature makes), and COIN_LOG_DIR /
 * COIN_SUPPORT_OUTPUT_DIR are pointed at throwaway directories so no test
 * touches the developer's real log or their real Desktop.
 */

import { describe, it, expect, afterEach, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

import {
  insertCoin,
  rebuildTestDatabase,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';
// Seeds real lines into the throwaway log directory, so the log-file tests
// read the same path the endpoint does rather than a fixture of their own.
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
 * The report `.md` the write endpoint just produced.
 *
 * Picked BY NAME rather than by being the only file in the directory: the
 * endpoint now writes a redacted log `.txt` beside it whenever the reporter
 * ticked "Include recent log", which is the default. How many files exist is
 * asserted on its own, by the tests that care, rather than smuggled into
 * every read.
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

/**
 * The dialog needs the repository URL on its FIRST screen, so it can offer a
 * real clickable link next to "attach your files on GitHub". Getting it out
 * of the preview response instead would mean building the whole report —
 * reading the log, querying the database — just to render a hyperlink.
 */
describe('GET /api/support/config', () => {
  it('reports where issues are filed and where the file will go', async () => {
    const res = await request(app).get('/api/support/config');

    expect(res.status).toBe(200);
    expect(typeof res.body.repositoryUrl).toBe('string');
    expect(res.body.repositoryUrl.length).toBeGreaterThan(0);
    expect(res.body.outputDirectory).toBe(dirs.outDir);
  });

  /**
   * LOAD-BEARING. While SUPPORT_REPO_URL is still the shipped placeholder the
   * dialog must say the repository is not configured rather than hand the
   * user a link to a 404 and tell them their report has been filed.
   */
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
    // Real rows, and three DIFFERENT counts on purpose: the report's three
    // COUNT(*) subqueries are easy to transpose, and a fixture where coins
    // and photos were both 2140 (as the mocked one was) could not have
    // detected it.
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
          `INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount)
           VALUES ('t-1', 'c-1', 'purchase', '2026-01-01', 10)`
        )
        .run();
    });

    const res = await request(app).post('/api/support/preview').send({});

    expect(res.body.markdown).toContain('- coins: 3');
    expect(res.body.markdown).toContain('- photos: 2');
    expect(res.body.markdown).toContain('- transactions: 1');
  });

  /**
   * THE MOST IMPORTANT TEST IN THIS FILE. If the report needed a working
   * database, it would be unavailable in precisely the situation it exists
   * for. The packaging design calls a support channel that silently fails
   * worse than no support channel at all; one that loudly fails is no
   * better.
   */
  it('still produces a report when the database is unreachable', async () => {
    // Broken for real: the counts query reads Coins, and the table is not
    // there. (It used to be a mocked ECONNREFUSED, an mssql-era socket error
    // that cannot occur against a local file.) The table is rebuilt in
    // afterEach.
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

  /**
   * The app has no picker any more, so it has nothing to list — and must not
   * invent one. A report claiming to carry files the app never saw would be
   * read on an issue that may well have files dragged onto it, where nobody
   * could then tell which of them the app put there.
   */
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

  /**
   * UNTICKED MEANS NO LOG CONTENT, BODY INCLUDED. Leaving the 150-line tail
   * in the report while the dialog says the log is not included would make
   * the unticked state a half-truth — and a user who turned it off because
   * they did not want log lines in a public issue would publish 150 of them.
   */
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

  /**
   * "Not included" and "not available" are different facts. The first sends
   * the owner back to ask for a log; the second sends them hunting a logging
   * bug that does not exist.
   */
  it('says the reporter chose to leave it out, not that none was available', async () => {
    const res = await request(app).post('/api/support/preview').send({ includeLog: false });

    expect(res.body.markdown).toMatch(/not included/i);
    expect(res.body.markdown).not.toMatch(/No log lines were available/i);
  });

  /** Nothing has been consented to yet, so nothing may exist on disk yet. */
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

  /**
   * The owner's instruction, end to end: no archive. A user who opens this
   * file gets the report, not a prompt to extract something.
   */
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
   * TWO PATHS, TWO AUDIENCES, AND THEY MUST NOT BE SWAPPED.
   * `path` is shown on the user's own screen and goes in the server log, so
   * it is the real one. `redactedPath` goes in the issue body, which is
   * PUBLIC, so it must not carry the user name.
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

  /**
   * The in-app picker is gone and so is the endpoint that took files. An
   * `attachments` array is now meaningless input; it must be ignored rather
   * than silently acted upon, and above all nothing extra may be written.
   */
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
 * WHY THIS BLOCK EXISTS. Removing the zip removed the only REDACTED log a
 * user could share: the report body carries 150 lines, and the 2,000-line
 * tail that sat in the archive went with it. What was left to drag into a
 * PUBLIC issue was the raw `app.log`, full of the account name, the machine
 * name and photo paths. The checkbox closes that gap, so the things these
 * tests hold down are safety properties, not conveniences:
 *
 *  - ticked writes a SECOND file and unticked writes NOTHING extra;
 *  - unticked also removes the log tail from the report body, or the
 *    unticked state would be a half-truth;
 *  - both files are redacted by the SAME redactor, so the same path reads
 *    identically in each;
 *  - the log path that travels to the issue is the redacted one.
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

  /** Two draggable files, not an archive. The zip is not coming back. */
  it('the log file is plain readable text, not an archive', async () => {
    seedLog('plain-text-case');
    await request(app).post('/api/support/report').send({ markdown: 'x', includeLog: true });

    const log = writtenLog()!;
    expect(log.slice(0, 2)).not.toBe('PK');
    expect(log).toMatch(/Coin Inventory/);
  });

  /**
   * Both files are named from ONE instant, so the pair is obviously a pair on
   * a Desktop that may already hold three of each.
   */
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

  /**
   * TWO PATHS, TWO AUDIENCES — the same rule the report file already follows.
   * `log.path` is for the user's own screen, so it is real. `log.redactedPath`
   * goes in the public issue body, so it must not carry the user name.
   */
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
   * THE SHARED REDACTOR, END TO END. Two independently-redacted files would
   * allocate placeholders in their own first-seen order, so the same folder
   * could be <USER2> in the report and <USER3> in the log — and the pair
   * would then actively mislead a reader into believing two different
   * accounts were involved.
   *
   * `alice` and `bob` are strangers to this machine, so neither gets the
   * reserved <USER>; they are exactly the values a second redactor would
   * number differently. The report mentions them in one order and the log
   * (through the seeded line) in another.
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

    // Whatever aliases were handed out, they must be the same two in both.
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
   * `path` is deliberately NOT part of this assertion: it is the real local
   * path, shown only on the user's own screen, and redacting it there would
   * tell them to look somewhere that does not exist. `redactedPath` is the
   * one that travels, and it is checked separately below.
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
   * THE NEW FILE GETS ITS OWN CANARY, and it has to: the log file exists
   * precisely so that the user has something redacted to drag into a public
   * issue INSTEAD of the raw `app.log`. A log file that carried the account
   * name would be the raw log with extra steps, and would be worse than not
   * offering one, because the dialog tells the user it is safe.
   *
   * The marker is planted in all three places the redactor reads — the user
   * name, the machine name, and a path — and in the LOG itself, which is
   * where the real risk lives.
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
    // It really did read the seeded line — otherwise this asserts nothing.
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
