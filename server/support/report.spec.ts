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
    attachments: [],
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

describe('attachments', () => {
  it('names them, with a reminder that the user chose them', () => {
    const { markdown } = buildSupportReport(
      snapshot({ attachments: [{ name: 'GoldCoins.QIF', bytes: 2048 }] }),
      IDENTITY
    );

    expect(markdown).toContain('GoldCoins.QIF');
    expect(markdown).toMatch(/chose|attached/i);
  });

  it('says nothing was attached when nothing was', () => {
    const { markdown } = buildSupportReport(snapshot(), IDENTITY);
    expect(markdown).toMatch(/no files/i);
  });

  it('redacts a file NAME that carries the user name', () => {
    const { markdown } = buildSupportReport(
      snapshot({ attachments: [{ name: 'devuser-holdings.qif', bytes: 10 }] }),
      IDENTITY
    );
    expect(markdown).not.toContain('devuser-holdings');
    expect(markdown).toContain('<USER>-holdings.qif');
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
      attachments: [{ name: `user${CANARY}-holdings.qif`, bytes: 4096 }],
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
