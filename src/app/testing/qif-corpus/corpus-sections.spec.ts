/* ===========================================================================
 * corpus-sections.spec.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES
 *   That `QuickenImportService.parse` reads a WHOLE Quicken export -- not a
 *   hand-built two-line `!Type:Invst` snippet -- and comes back with coins
 *   and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS, AND WHY IT IS NEW
 * ---------------------------------------------------------------------------
 *   Every other spec that touches the importer feeds it a QIF it built
 *   itself, one block long. `qif-accounts.fixture.ts` does too: it scans the
 *   corpus for `Y` lines with its own reader and then re-wraps them, because
 *   what it wants is the SECURITY NAMES and not the net-quantity rule.
 *
 *   So until this file, NOTHING ran the parser over a real file end to end,
 *   and the only reason that was survivable is that the owner's own exports
 *   were sitting in the repository root where a human could try them by hand.
 *   They are gone. If the corpus that replaced them held nothing but coins,
 *   the parser's entire IGNORE half would stop being exercised -- and the
 *   owner's instinct about it,
 *
 *       "The QIFs might carry that information but I don't see why this
 *        application would do anything but ignore stuff that it doesn't
 *        actually store."
 *
 *   is exactly right and exactly the kind of thing that silently stops being
 *   true. A regression that made the parser choke on a `!Type:Cat` block, or
 *   worse, ingest a stock position as a coin, would reach the import button
 *   with every other test still green.
 *
 * ---------------------------------------------------------------------------
 * THE SECTIONS, AND WHICH CODE PATH DROPS EACH ONE
 * ---------------------------------------------------------------------------
 *   READ
 *     !Account       its `N` line names the account the following
 *                    transactions belong to; also feeds the account picker.
 *     !Type:Invst    blocks with a `Y` security line.
 *
 *   IGNORED, each somewhere different -- which is why one assertion per
 *   section is not redundant:
 *     !Type:Prices   short-circuited by name, before any field parsing.
 *     !Type:Security }
 *     !Type:Cat      } all have an `N` line, so `parseInvestmentFields`
 *     !Type:Tag      } accepts them as transaction-shaped and the next test
 *     !Type:Bank     } -- "no `Y` line" -- is what drops them.
 *     NXIn / NXOut   an explicit action skip-list.
 *     !Option: / !Clear:AutoSwitch
 *                    neither `!Account` nor `!Type`, so they reach
 *                    `parseInvestmentFields` and come back null.
 *
 *   The corpus in this directory carries a synthetic version of every one of
 *   them. The securities are invented and their tickers all begin "ZQ",
 *   which is not a form any US exchange issues, so nothing in here can be
 *   looked up as a real holding. See `generate-corpus.mjs`.
 * ======================================================================== */

import { describe, expect, it } from 'vitest';
import { QIF_ACCOUNTS, decodeQif } from '../qif-accounts.fixture';
import { QuickenImportService } from '../../services/quicken-import.service';

/** Ancients is excluded from QIF_ACCOUNTS; its file is tested here too. */
const FILES: ReadonlyArray<[string, string]> = [
  ...QIF_ACCOUNTS.map((a) => [a.file, a.account] as [string, string]),
  ['Ancients.QIF', 'Ancients']
];

const parse = (text: string, account?: string) => new QuickenImportService().parse(text, account);

/** The record's raw Quicken security name, which the interface does not declare. */
const securityNameOf = (record: unknown) => (record as { securityName: string }).securityName;

/**
 * Words that may never reach a coin record. Each is a thing the real export
 * carried in bulk and the corpus carries a synthetic stand-in for.
 */
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
    /* The tripwire for the silent corruption. 0xA2 is "¢" and 0xBD is "½";
     * read as UTF-8 both become U+FFFD and every denomination in the file is
     * destroyed without an error anywhere. */
    expect(text, 'a replacement character means the decode is wrong').not.toContain('�');
    expect(text, 'the corpus should contain cent signs').toContain('¢');
  });

  it('still contains every section the parser has to IGNORE', () => {
    /* Not a test of the parser -- a test of the CORPUS, and the reason it is
     * here is that everything below it would pass vacuously on a file of
     * nothing but coins. If a future regeneration "simplifies" the corpus,
     * this is the test that says so. */
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
    /* Every corpus file also holds `Driftwood Brokerage`, an investment
     * account whose register is nothing but stock and fund trades. It is
     * `!Type:Invst` with real `Y` lines, so the ONLY thing keeping it out is
     * the account filter -- which makes it the one non-coin section that a
     * "no `Y` line" test could never have caught. */
    const result = parse(text, account);
    const names = [...result.importedRecords, ...result.skippedRecords].map(securityNameOf);
    expect(names).not.toContain('Aldbury Manufacturing');
    expect(names).not.toContain('Broad Market Index Fund');
    expect(result.accounts).toContain('Driftwood Brokerage');
  });

  it('applies the net-quantity rule, so sold coins land in skippedRecords', () => {
    /* The corpus reproduces the real export's held/sold split per account --
     * the 2-3-20-cent collection really had held 112 coins and still owned 6
     * -- so both lists are non-empty on every account and the rule is
     * measured rather than assumed. */
    const result = parse(text, account);
    expect(result.importedRecords.length + result.skippedRecords.length + result.rejectedRecords.length)
      .toBeGreaterThan(0);
    expect(result.skippedRecords.length, `${account} sold nothing`).toBeGreaterThan(0);
  });

  it('raises no warnings on the sections it ignores', () => {
    // A warning is the parser saying it saw something it could not place.
    // Categories, tags, prices and bank rows are not that; they are expected.
    expect(parse(text, account).warnings).toEqual([]);
  });
});

describe('the ignored sections are ignored for the stated REASONS, not by luck', () => {
  const text = decodeQif('GoldCoins.QIF');

  it('a !Type:Cat block is transaction-shaped and still produces nothing', () => {
    /* Proven in isolation so the failure names the section. A category block
     * is `N` + `D`, which `parseInvestmentFields` accepts (`/^[DNYIQTUMO]/`
     * matches the `N`); it is the missing `Y` that drops it one step later. */
    const result = parse('!Type:Cat\nNPostage\nDShipping and insurance\nE\nR000\nE\n^\n');
    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('a !Type:Security block names a coin and is STILL not a coin record', () => {
    /* The sharpest of these. The master list holds every coin's name on an
     * `N` line, so a parser that read `N` as a security would import the
     * whole collection twice over -- once as securities and once as
     * transactions. */
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
    /* If the two were the same size the "ignores the master list" tests above
     * would be testing a file where there was nothing extra to ignore. */
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
