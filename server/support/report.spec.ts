/**
 * support/report.spec.ts — what the bundle contains, and what it must not.
 *
 * THE TWO PROMISES BEING TESTED
 *   1. The collection is described by COUNTS ONLY. Not one coin, price,
 *      note or photo path from the user's data goes into a report that is
 *      destined for a public issue tracker. "How big is your collection" is
 *      a useful debugging fact; "what is in it" is nobody's business.
 *
 *   2. Everything in the report has been through redaction, and the user is
 *      told what came out. The receipt is generated FROM the redaction pass,
 *      not written by hand, so it cannot drift from what actually happened.
 *
 * The caps are tested too, because an uncapped report is the same support
 * failure as an uncapped log: too big to send is the same as not sent.
 */

import { describe, it, expect } from 'vitest';

import { REPORT_LIMITS, SupportSnapshot, buildSupportReport } from './report';

const IDENTITY = {
  username: 'devuser',
  machineName: 'MYSERVER',
  homeDir: 'C:\\Users\\devuser'
};

function snapshot(overrides: Partial<SupportSnapshot> = {}): SupportSnapshot {
  return {
    generatedAt: '2026-11-08T18:00:00.000Z',
    appVersion: '0.0.0',
    serverVersion: '1.0.0',
    nodeVersion: 'v24.3.0',
    platform: 'win32',
    osRelease: '10.0.26200',
    arch: 'x64',
    counts: { coins: 2140, photos: 2140, transactions: 88 },
    clientErrors: [],
    logLines: [],
    logFiles: [],
    ...overrides
  };
}

describe('the header', () => {
  it('states the versions the owner will ask for first', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);

    expect(markdown).toContain('0.0.0');
    expect(markdown).toContain('v24.3.0');
    expect(markdown).toContain('win32');
    expect(markdown).toContain('10.0.26200');
  });

  it('is dated', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);
    expect(markdown).toContain('2026-11-08T18:00:00.000Z');
  });
});

describe('the collection — counts only, never content', () => {
  it('reports the counts it was given', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);
    expect(markdown).toContain('2140');
    expect(markdown).toContain('88');
  });

  it('says so plainly when the database could not be reached', () => {
    const { markdown } = buildSupportReport(
      snapshot({ counts: null, countsError: 'Database unavailable' }),
      IDENTITY
    );

    expect(markdown).toMatch(/could not be read|unavailable/i);
    // The report must still be generated. Half the reason somebody files a
    // problem report is that the database is not working, so a report that
    // needs a working database is a report that is missing exactly when it
    // is needed.
    expect(markdown).toContain('v24.3.0');
  });
});

describe('recent in-app errors', () => {
  it('includes them, newest first, with their timestamps', () => {
    const { markdown } = buildSupportReport(
      snapshot({
        clientErrors: [
          { timestamp: '2026-11-08T17:00:00.000Z', message: 'older failure' },
          { timestamp: '2026-11-08T17:05:00.000Z', message: 'newest failure' }
        ]
      }),
      IDENTITY
    );

    expect(markdown).toContain('newest failure');
    expect(markdown).toContain('older failure');
    expect(markdown.indexOf('newest failure')).toBeLessThan(markdown.indexOf('older failure'));
  });

  it('caps how many it carries', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      timestamp: '2026-11-08T17:00:00.000Z',
      message: `failure ${i}`
    }));

    const { markdown } = buildSupportReport(snapshot({ clientErrors: many }), IDENTITY);

    expect(markdown).not.toContain('failure 0');
    expect(markdown).toContain(`failure 199`);
    expect(markdown).toMatch(/\d+ older error/);
  });

  it('says there were none rather than leaving an empty heading', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);
    expect(markdown).toMatch(/no errors/i);
  });

  it('redacts them — they carry paths too', () => {
    const { markdown } = buildSupportReport(
      snapshot({
        clientErrors: [
          { timestamp: '2026-11-08T17:00:00.000Z', message: 'cannot read C:\\Users\\devuser\\pics' }
        ]
      }),
      IDENTITY
    );

    expect(markdown).not.toContain('devuser');
    expect(markdown).toContain('C:\\Users\\<USER>\\pics');
  });
});

describe('the log tail', () => {
  it('includes the lines it was given', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: ['[2026-11-08T17:00:00.000Z] [INFO] GET /api/coins'] }),
      IDENTITY
    );
    expect(markdown).toContain('GET /api/coins');
  });

  it('caps the number of lines and says how many were dropped', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const { markdown } = buildSupportReport(snapshot({ logLines: lines }), IDENTITY);

    expect(markdown).toContain('line 4999');
    // Anchored, because a bare `not.toContain('line 0')` would also be
    // satisfied by 'line 0' never having been rendered in any form — and
    // because 'line 0' is a prefix of 'line 01' and friends.
    expect(markdown).not.toMatch(/^line 0$/m);
    expect(markdown).toMatch(/earlier line/i);
  });

  it('truncates an absurdly long single line', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: ['x'.repeat(50_000)] }),
      IDENTITY
    );

    expect(markdown).not.toContain('x'.repeat(REPORT_LIMITS.maxLineChars + 1));
    expect(markdown).toContain('…');
  });

  it('redacts the real connection line from this application', () => {
    const { markdown } = buildSupportReport(
      snapshot({
        logLines: [
          'Connecting to SQL Server at MYSERVER\\SQLEXPRESS/CoinInventory',
          '  at formatDate (C:/Users/devuser/source/dev/server/server.ts:130:12)'
        ]
      }),
      IDENTITY
    );

    expect(markdown).not.toContain('MYSERVER');
    expect(markdown).not.toContain('devuser');
    expect(markdown).toContain('<MACHINE>\\SQLEXPRESS');
    expect(markdown).toContain('C:/Users/<USER>/source/dev/server/server.ts:130:12');
  });
});

/**
 * "INCLUDE THE LOG" HAS TO MEAN ALL OF IT.
 *
 * The checkbox's visible effect is the second file, but the body tail is the
 * part that can quietly betray the choice: a user who unticks the box because
 * they do not want log lines in a public issue would otherwise publish 150 of
 * them in the report itself and never know. That would make the unticked
 * state a half-truth, which is worse than not offering the choice.
 */
describe('the log tail when the reporter did not ask for the log', () => {
  const LINES = [
    'Connecting to SQL Server at MYSERVER\\SQLEXPRESS/CoinInventory',
    '[INFO] rendered C:/Users/devuser/Pictures/coin.jpg'
  ];

  it('carries no log lines at all', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: LINES, includeLog: false }),
      IDENTITY
    );

    expect(markdown).not.toContain('SQLEXPRESS');
    expect(markdown).not.toContain('Pictures');
    expect(markdown).not.toContain('rendered');
  });

  /**
   * "Not included" and "none was available" are different facts, and only one
   * of them is true. Reporting the wrong one sends the owner hunting a
   * logging bug that does not exist instead of asking for the log.
   */
  it('says the reporter left it out, not that there was nothing to show', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: LINES, includeLog: false }),
      IDENTITY
    );

    expect(markdown).toMatch(/Not included/i);
    expect(markdown).toMatch(/Include recent log/);
    expect(markdown).not.toMatch(/No log lines were available/i);
  });

  it('says no log file was written beside the report either', () => {
    const { markdown } = buildSupportReport(snapshot({ includeLog: false }), IDENTITY);
    expect(markdown).toMatch(/no log file was written/i);
  });

  /**
   * Names and sizes are not log CONTENT, and they answer a question worth
   * answering — "is it even logging?" — so they stay. The dialog's summary
   * says so in the same breath, rather than leaving them under a sentence
   * that implies nothing log-related is sent.
   */
  it('still lists the names and sizes of the log files', () => {
    const { markdown } = buildSupportReport(
      snapshot({
        includeLog: false,
        logFiles: [{ name: 'app-2026-11-08.log', bytes: 123456 }]
      }),
      IDENTITY
    );

    expect(markdown).toContain('app-2026-11-08.log');
  });

  /** Omitted means ticked: the checkbox's default, and every older caller. */
  it('treats an absent flag as "include", matching the checkbox default', () => {
    const { markdown } = buildSupportReport(snapshot({ logLines: LINES }), IDENTITY);
    expect(markdown).toContain('SQLEXPRESS');
  });
});

describe('the log file inventory', () => {
  it('lists names and sizes, not contents', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logFiles: [{ name: 'app-2026-11-08.log', bytes: 123456 }] }),
      IDENTITY
    );

    expect(markdown).toContain('app-2026-11-08.log');
    expect(markdown).toMatch(/120(\.\d)? KB|123456/);
  });
});

/**
 * The in-app picker is gone, so the report no longer lists attachments — it
 * cannot: the app never sees them. What it must still do is SAY so, in the
 * document itself, because the report is read on a GitHub issue that may well
 * have files dragged onto it, and a reader has to be able to tell which of
 * them the app put there. The answer is none.
 */
describe('attachments', () => {
  it('states that the app attached and uploaded nothing', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);

    expect(markdown).toMatch(/attached nothing and uploaded nothing/i);
  });

  it('does not claim to have collected any file', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);

    expect(markdown).not.toMatch(/in the zip/i);
    expect(markdown).not.toMatch(/files you chose to attach/i);
  });
});

describe('the receipt section', () => {
  it('appears in the report, in plain words, with counts', () => {
    const { markdown, receipt } = buildSupportReport(
      snapshot({
        logLines: [
          'C:/Users/devuser/a',
          'C:/Users/devuser/b',
          'Password=hunter2;'
        ]
      }),
      IDENTITY
    );

    expect(markdown).toMatch(/what was removed/i);
    expect(markdown).toContain('<USER>');
    expect(markdown).toMatch(/your Windows user name/i);
    expect(receipt.find(e => e.placeholder === '<USER>')!.occurrences).toBe(2);
  });

  it('never prints the value it removed', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: ['Password=hunter2;', 'C:/Users/devuser/a'] }),
      IDENTITY
    );
    expect(markdown).not.toContain('hunter2');
    expect(markdown).not.toContain('devuser');
  });

  it('says nothing needed removing when nothing did', () => {
    const { markdown } = buildSupportReport(
      snapshot({ logLines: ['[INFO] GET /api/coins'] }),
      { username: 'nobodyatall', machineName: 'NOMACHINE' }
    );
    expect(markdown).toMatch(/nothing (needed|was) remov/i);
  });
});

describe('the whole report is bounded', () => {
  it('stays under the size cap even when fed everything at once', () => {
    const { markdown } = buildSupportReport(
      snapshot({
        logLines: Array.from({ length: 20_000 }, (_, i) => `line ${i} `.repeat(200)),
        clientErrors: Array.from({ length: 2000 }, (_, i) => ({
          timestamp: '2026-11-08T17:00:00.000Z',
          message: `boom ${i} `.repeat(200)
        })),
        logFiles: Array.from({ length: 400 }, (_, i) => ({ name: `app-2026-01-${i}.log`, bytes: i }))
      }),
      IDENTITY
    );

    expect(markdown.length).toBeLessThan(REPORT_LIMITS.maxReportChars);
  });
});

// Canary — through the real report builder this time

describe('canary: a marker seeded into every channel does not reach the report', () => {
  const CANARY = 'CANARYLEAK7391';

  const identity = {
    username: `user${CANARY}`,
    machineName: `pc${CANARY}`,
    homeDir: `C:\\Users\\user${CANARY}`
  };

  const { markdown, receipt } = buildSupportReport(
    snapshot({
      logLines: [
        `Connecting to SQL Server at pc${CANARY}\\SQLEXPRESS/CoinInventory`,
        `  at formatDate (C:/Users/user${CANARY}/source/dev/server/server.ts:130:12)`,
        `Server=pc${CANARY};Database=CoinInventory;User Id=sa;Password=${CANARY};`,
        `photo \\\\pc${CANARY}\\Coin Pictures\\1881-S.jpg`
      ],
      clientErrors: [
        { timestamp: '2026-11-08T17:00:00.000Z', message: `failed for user${CANARY}` }
      ],
      // The marker used to ride in on an attachment NAME. The in-app picker
      // is gone, so it rides in on the user's own description instead —
      // the same string, through a carrier that still exists, so the canary
      // keeps exactly the reach it had.
      userDescription: `I was exporting user${CANARY}-holdings.qif when it crashed`,
      logFiles: [{ name: 'app-2026-11-08.log', bytes: 10 }]
    }),
    identity
  );

  it('is absent from the markdown', () => {
    expect(markdown).not.toContain(CANARY);
  });

  it('is absent from the receipt', () => {
    expect(JSON.stringify(receipt)).not.toContain(CANARY);
  });

  it('leaves a report that is still worth reading', () => {
    expect(markdown).toContain('SQLEXPRESS');
    expect(markdown).toContain('server.ts:130:12');
    expect(markdown).toContain('Coin Pictures');
    expect(markdown).toContain('-holdings.qif');
  });
});
