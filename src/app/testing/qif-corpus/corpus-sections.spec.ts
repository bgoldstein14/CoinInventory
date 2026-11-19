/*
 * Parses whole Quicken exports from the corpus (the only spec that does; the
 * others use one-block snippets) and checks that only coins come out.
 *
 * Read: `!Account` (its `N` line names the account) and `!Type:Invst` blocks
 * with a `Y` security line. Ignored, each by a different code path:
 *   !Type:Prices                   skipped by name before field parsing
 *   !Type:Security/Cat/Tag/Bank    have an `N` line but no `Y` line, so dropped
 *   NXIn / NXOut                   explicit action skip-list
 *   !Option: / !Clear:AutoSwitch   `parseInvestmentFields` returns null
 *
 * All corpus securities are invented; their tickers begin "ZQ".
 */

import { describe, expect, it } from 'vitest';
import { QIF_ACCOUNTS, decodeQif } from '../qif-accounts.fixture';
import { QuickenImportService } from '../../services/quicken-import.service';

/**
 * Files that import no coins at all. Ancient coins have no year, denomination
 * or grade, so every row fails the 2-of-3 main-detail rule and is rejected.
 */
const IMPORTS_NOTHING = new Set(['Ancients.QIF']);

/** Ancients is excluded from QIF_ACCOUNTS; its file is tested here too. */
const FILES: ReadonlyArray<[string, string]> = [
  ...QIF_ACCOUNTS.map((a) => [a.file, a.account] as [string, string]),
  ['Ancients.QIF', 'Ancients']
];

const parse = (text: string, account?: string) => new QuickenImportService().parse(text, account);

/** The record's raw Quicken security name, which the interface does not declare. */
const securityNameOf = (record: unknown) => (record as { securityName: string }).securityName;

/** Words from non-coin sections that must never reach a coin record. */
const NEVER_A_COIN = [
  'ZQ',              // every invented ticker, and every non-coin security name's symbol
  'Fund',            // mutual funds
  'Bond 20',         // the savings and municipal bonds
  'Call', 'Put',     // option positions
  'Composite',       // market indices
  'Postage', 'Storage', 'Grading Fees', 'Auction Fees' // categories
];

describe.each(FILES)('%s — a whole export, parsed the way the import button does', (file, account) => {
  const text = decodeQif(file);

  it('decoded as WINDOWS-1252, not UTF-8', () => {
    // Read as UTF-8, 0xA2 ("¢") and 0xBD ("½") would silently become U+FFFD.
    expect(text, 'a replacement character means the decode is wrong').not.toContain('�');
    expect(text, 'the corpus should contain cent signs').toContain('¢');
  });

  it('still contains every section the parser has to IGNORE', () => {
    // Checks the corpus itself: the tests below would pass vacuously without these sections.
    for (const section of [
      '!Type:Tag', '!Type:Cat', '!Type:Security', '!Type:Prices', '!Type:Bank',
      '!Option:AutoSwitch', '!Clear:AutoSwitch', 'NXIn'
    ]) {
      expect(text, `${file} no longer contains ${section}`).toContain(section);
    }
  });

  it('finds the coin account, among the many accounts the file lists', () => {
    const result = parse(text);
    expect(result.accounts).toContain(account);
    expect(result.accounts.length, 'the file should list more than one account').toBeGreaterThan(1);
  });

  it('imports coins and NOTHING from the non-coin sections', () => {
    const result = parse(text, account);
    const everyRecord = [
      ...result.importedRecords,
      ...result.skippedRecords,
      ...result.rejectedRecords.map((r) => r.record)
    ];
    expect(everyRecord.length, 'the account produced no records at all').toBeGreaterThan(0);

    for (const record of everyRecord) {
      const name = securityNameOf(record) ?? '';
      for (const forbidden of NEVER_A_COIN) {
        expect(name, `"${name}" came out of a section the parser must ignore`)
          .not.toContain(forbidden);
      }
    }
  });

  it('filters by account: the brokerage register in the same file is excluded', () => {
    // `Driftwood Brokerage` is a stock/fund register with real `Y` lines, so
    // only the account filter keeps it out.
    const result = parse(text, account);
    const names = [...result.importedRecords, ...result.skippedRecords].map(securityNameOf);
    expect(names).not.toContain('Aldbury Manufacturing');
    expect(names).not.toContain('Broad Market Index Fund');
    expect(result.accounts).toContain('Driftwood Brokerage');
  });

  it('imports the sold coins too, and names them', () => {
    // Sold coins are imported by default; `soldSecurityNames` is always
    // populated so the import can mark them Sold.
    const result = parse(text, account);
    expect(result.importedRecords.length + result.rejectedRecords.length).toBeGreaterThan(0);
    expect(result.skippedRecords, 'nothing was asked to be held out').toEqual([]);
    expect(result.soldSecurityNames.length, `${account} sold nothing`).toBeGreaterThan(0);

    if (IMPORTS_NOTHING.has(file)) return;

    const imported = result.importedRecords.map(securityNameOf);
    const soldAndImported = result.soldSecurityNames.filter((name) => imported.includes(name));
    expect(soldAndImported.length, `${account} imported none of its sold coins`)
      .toBeGreaterThan(0);
  });

  it('holds the sold coins out, and lists them, when asked to', () => {
    // The import modal's option: sold coins move from `importedRecords` to
    // `skippedRecords`, where the dialog lists them.
    const everything = parse(text, account);
    const heldOnly = new QuickenImportService().parse(text, account, undefined, {
      excludeSold: true
    });

    expect(heldOnly.soldSecurityNames).toEqual(everything.soldSecurityNames);

    if (IMPORTS_NOTHING.has(file)) return;

    expect(heldOnly.importedRecords.length).toBeLessThan(everything.importedRecords.length);
    expect(heldOnly.skippedRecords.length, `${account} held nothing out`).toBeGreaterThan(0);
  });

  it('raises no warnings on the sections it ignores', () => {
    // Categories, tags, prices and bank rows are expected, so they must not warn.
    expect(parse(text, account).warnings).toEqual([]);
  });
});

describe('the ignored sections are ignored for the stated REASONS, not by luck', () => {
  const text = decodeQif('GoldCoins.QIF');

  it('a !Type:Cat block is transaction-shaped and still produces nothing', () => {
    // `parseInvestmentFields` accepts the `N` line; the missing `Y` line drops it.
    const result = parse('!Type:Cat\nNPostage\nDShipping and insurance\nE\nR000\nE\n^\n');
    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('a !Type:Security block names a coin and is STILL not a coin record', () => {
    // The master list names every coin on an `N` line; reading it as a
    // security would import each coin twice.
    const result = parse('!Type:Security\nN1905 $20 - PCGS MS64\nTGold Coin\n^\n');
    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords).toEqual([]);
  });

  it('a !Type:Prices block is dropped before its fields are read at all', () => {
    const result = parse('!Type:Prices\n"ZQALDB",41.22," 3/ 4\'24"\n^\n');
    expect(result.importedRecords).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('an XIn cash transfer carries no coin even though it is in the register', () => {
    const result = parse(
      '!Account\nNGold Coins\nTInvst\n^\n' +
      '!Type:Invst\nD1/15\'10\nNXIn\nPHarbourstone Coins\nT1,500.00\nMOpening transfer\n^\n',
      'Gold Coins'
    );
    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords).toEqual([]);
  });

  it('the corpus master list is bigger than the account, on every file', () => {
    // Guards the corpus: otherwise the master-list tests have nothing extra to ignore.
    for (const [file, account] of FILES) {
      const body = decodeQif(file);
      const securities = (body.match(/!Type:Security/g) ?? []).length;
      const imported = parse(body, account);
      const coins =
        imported.importedRecords.length +
        imported.skippedRecords.length +
        imported.rejectedRecords.length;
      expect(securities, `${file}: master list ${securities} vs account ${coins}`)
        .toBeGreaterThan(coins);
    }
  });
});
