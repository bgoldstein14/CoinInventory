/*
 * QIF IMPORT -- THE CONSOLIDATED SPEC.
 *
 * Three smaller specs were folded into this file; each one's own header
 * comment is reproduced verbatim as a banner immediately above the block of
 * describes it came from:
 *
 *   - quicken-sold-date.spec.ts
 *   - quicken-payee-not-a-dealer.spec.ts
 *   - quicken-authenticity.spec.ts
 *
 * The only edit made to the folded-in tests is a rename: both the sold-date
 * and the payee file declared a top-level helper called `parse`, with
 * different signatures, so they are now `parseSold` and `parsePayee`
 * respectively. No assertion was changed.
 *
 * quicken-corpus-securities.spec.ts is deliberately NOT part of this file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QuickenImportService,
  checkMainCoinDetails,
  isCoinDetailPresent
} from './quicken-import.service';
import { QIF_ACCOUNTS, decodeQif } from '../testing/qif-accounts.fixture';
import { isSoldRecord } from './import-sold';

describe('QuickenImportService', () => {
  it('parses a QIF investment transaction into a normalized record', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NAdd
Y1853 US Half Dime FS-101
T12.50
MOriginal owner note
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    // parseAttributes converts "Half Dime" to symbolic "5¢"
    expect(result.importedRecords[0].denomination).toBe('5¢');
    expect(result.importedRecords[0].purchasePrice).toBe(12.5);
    expect(result.importedRecords[0].currentValue).toBe(12.5);
    expect(result.importedRecords[0].purchaseDate).toBe('2024-01-15');
    expect(result.importedRecords[0].notes).toBe('Original owner note');
    expect(result.importedRecords[0].year).toBe('1853');
    // Year + denomination are enough to infer the series.
    expect(result.importedRecords[0].coinType).toBe('Seated Liberty Half Dime');
  });

  it('silently skips a block with no security name', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-01-15
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('skips fully disposed coins when asked to, without surfacing warnings', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T5.00
^
D02/20/2024
NSell
Y1964 Quarter
T6.00
^
`;

    // `excludeSold` is the import modal's "only coins I still own" tick box,
    // and it is UNTICKED by default -- see the sibling test below.
    const result = service.parse(qif, undefined, undefined, { excludeSold: true });

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.warnings.some(w => w.includes('fully disposed') || w.includes('net quantity is'))).toBe(false);
  });

  it('imports a fully disposed coin BY DEFAULT, and says it is sold', () => {
    /* THE REVERSAL. This parser used to drop every sold coin
     * unconditionally and the modal did not even list what it had dropped:
     * over the QIF corpus that is 379 of 484 coin records gone in silence.
     * A coin the owner no longer has is still a coin he had, and the cost,
     * the grade and the sale are exactly what he wants to report on. */
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T5.00
^
D02/20/2024
NSell
Y1964 Quarter
T6.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].denomination).toBe('25¢');
    // Nothing is being held out, so there is nothing to report as held out.
    expect(result.skippedRecords).toHaveLength(0);
    // ...but the caller is still told which coins are gone, so it can mark
    // them Sold rather than adding them to the collection's value.
    expect(result.soldSecurityNames).toEqual(['1964 Quarter']);
  });

  it('parses multiple transactions into separate imported records', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NAdd
Y1853 US Half Dime
T12.50
^
D02/20/2024
NAdd
Y1964 Quarter
T30.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].denomination).toBe('5¢');
    expect(result.importedRecords[1].denomination).toBe('25¢');
  });

  it('allows importing only the selected account when multiple accounts are present', () => {
    const service = new QuickenImportService();
    const qif = `!Account
NChecking
^
!Type:Invst
D01/15/2024
NAdd
Y1853 US Half Dime
T12.50
^
!Account
NSavings
^
!Type:Invst
D02/20/2024
NAdd
Y1964 Quarter
T30.00
^
`;

    const result = service.parse(qif, 'Checking');

    expect(result.accounts).toEqual(expect.arrayContaining(['Checking', 'Savings']));
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].denomination).toBe('5¢');
    expect(result.importedRecords[0].account).toBe('Checking');
  });

  it('silently drops a standalone sell with no matching buy', () => {
    const service = new QuickenImportService();
    // A standalone Sell (no prior Buy) means no latestRecord was ever set,
    // so the net-quantity filter has nothing to skip or warn about.
    const qif = `!Type:Invst
D03/01/2024
NSell
YMercury Dime 1945-S
T24.00
MSold to dealer
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    // No warning for standalone sells — no acquisition record to reference
    expect(result.skippedRecords).toHaveLength(0);
  });

  it('warns but still imports an unrecognized action code', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/01/2024
NWeirdAction
YSeated Liberty Quarter
T80.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.warnings[0]).toContain('WeirdAction');
  });

  it('ignores negative-value transactions and reports them as warnings', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T25.00
^
D02/15/2024
NBuy
Y1853 Half Dollar
T-10.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].denomination).toBe('25¢');
    expect(result.warnings.some(w => w.includes('negative value') && w.includes('Half Dollar'))).toBe(true);
  });

  it('falls back to price times quantity plus commission when no amount field is present', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D08/25/1993
NBuy
YLiberty Head Double Eagle
I2450.00
Q1
O25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].purchasePrice).toBe(2475);
  });

  it('tolerates comma-formatted amounts and 2-digit years', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D8/25/93
NBuyX
YLiberty Head Double Eagle
T2,450.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].purchasePrice).toBe(2450);
    expect(result.importedRecords[0].purchaseDate).toBe('1993-08-25');
  });

  it('handles single-digit years from Quicken date formats', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D8/ 8' 4
NBuy
Y1864 Two Cent
T12.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].purchaseDate).toBe('2004-08-08');
  });

  it('silently skips XIn and XOut cash transfer actions', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D5/19' 7
NXIn
YSome Security
U37.00
T37.00
M1864 2c LM - XF45
^
D6/ 8' 7
NXOut
YAnother Security
U25.00
T25.00
MSold 1864 LM 2c - VF
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('sets coinType to empty string rather than the QIF action code', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuyX
YLiberty Head Double Eagle
T2450.00
^
`;

    const result = service.parse(qif);

    // coinType inferred from explicit name in security string
    expect(result.importedRecords[0].coinType).toBe('Liberty Head');
  });

  // --- Net-quantity filtering tests ---

  it('filters out coins with net quantity <= 0 (bought then sold)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T5.00
^
D02/20/2024
NSell
Y1964 Quarter
T6.00
^
`;

    const result = service.parse(qif, undefined, undefined, { excludeSold: true });

    // Coin was bought then sold - net quantity is 0, and the caller asked
    // for only the coins still held, so it is reported as held out.
    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.skippedRecords[0].denomination).toBe('25¢');
    expect(result.warnings.some(w => w.includes('net quantity is'))).toBe(false);
  });

  it('imports coins with net quantity > 0 (bought, never sold)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T5.00
^
`;

    const result = service.parse(qif);

    // Coin was bought but never sold - net quantity is 1, should be imported
    expect(result.importedRecords).toHaveLength(1);
    expect(result.skippedRecords).toHaveLength(0);
    expect(result.importedRecords[0].denomination).toBe('25¢');
  });

  // --- Attribute parsing tests ---

  it('parses year, mintmark, denomination, and grade from security name (1875S 20c-XF)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1875S 20c-XF
T25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.year).toBe('1875');
    expect(coin.mintMark).toBe('S');
    expect(coin.denomination).toBe('20¢');
    expect(coin.grade).toBe('XF');
  });

  it('parses 3CS denomination with year and grade (1861 3CS - AU)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1861 3CS - AU
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.year).toBe('1861');
    expect(coin.denomination).toBe('3CS');
    expect(coin.grade).toBe('AU');
  });

  it('parses complex mintmark (1878CC Dollar MS63)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1878CC Dollar MS63
T150.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.year).toBe('1878');
    expect(coin.mintMark).toBe('CC');
    // parseAttributes converts "Dollar" to symbolic "$1"
    expect(coin.denomination).toBe('$1');
    expect(coin.grade).toBe('MS63');
  });

  it('parses hyphenated mint marks like 1880-S Morgan Dollar', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1880-S Morgan Dollar
T250.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.year).toBe('1880');
    expect(coin.mintMark).toBe('S');
    expect(coin.denomination).toBe('$1');
    expect(coin.coinType).toBe('Morgan');
  });

  it('skips records that are missing both year and denomination data', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
YUnknown Security Item
T250.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(0);
    // Not silently dropped -- reported as an exception the user can see.
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0].securityName).toBe('Unknown Security Item');
  });

  it('parses BU grade for Buffalo, Franklin, Lincoln, and D-mint coins', () => {
    const service = new QuickenImportService();

    const checks = [
      { qif: `!Type:Invst\nD01/15/2024\nNBuy\nY1936 Buffalo 5C BU\nT20.00\n^`, expected: 'BU' },
      { qif: `!Type:Invst\nD01/15/2024\nNBuy\nY1956 Franklin Half Dollar BU\nT25.00\n^`, expected: 'BU' },
      { qif: `!Type:Invst\nD01/15/2024\nNBuy\nY1945 Lincoln Cent BU\nT5.00\n^`, expected: 'BU' },
      { qif: `!Type:Invst\nD01/15/2024\nNBuy\nY1959D Lincoln Cent BU\nT5.00\n^`, expected: 'BU' }
    ];

    for (const check of checks) {
      const result = service.parse(check.qif);
      expect(result.importedRecords).toHaveLength(1);
      expect(result.importedRecords[0].grade).toBe(check.expected);
    }
  });

  // --- PM pre-fill tests ---

  it('pre-fills pmWeightGrams and pmPercent for known US silver coins (1960 Quarter)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1960 Quarter
T5.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    // 1960 US Quarter: 90% silver, 5.63g PM weight
    expect(coin.pmWeightGrams).toBeCloseTo(5.63, 2);
    expect(coin.pmPercent).toBe(90);
  });

  it('pre-fills pmWeightGrams and pmPercent for known US silver coins (1964D Dime)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964D Dime
T3.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    // 1964 US Dime: 90% silver, 2.25g PM weight
    expect(coin.pmWeightGrams).toBeCloseTo(2.25, 2);
    expect(coin.pmPercent).toBe(90);
  });

  it('does not pre-fill pmWeightGrams for unknown coins', () => {
    const service = new QuickenImportService();
    // A copper cent: importable (year + type + denomination) but the precious
    // metal reference table has no entry for 1¢, so nothing is pre-filled.
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1890 Indian Head Cent
T10.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.pmWeightGrams).toBeUndefined();
    expect(coin.pmPercent).toBeUndefined();
  });

  // --- Odd Type denomination + coinType enrichment tests ---

  it('parses Half Cent with correct denomination and coinType (1809 Half Cent)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1809 Half Cent-VG
T150.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.denomination).toBe('½¢');
    expect(coin.coinType).toBe('Classic Head Half Cent');
    expect(coin.year).toBe('1809');
    expect(coin.grade).toBe('VG');
  });

  it('parses Two Cent with correct denomination and coinType (1864 Two Cent)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1864 Two Cent
T12.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.denomination).toBe('2¢');
    expect(coin.coinType).toBe('Two Cent');
  });

  it('parses Twenty Cent with correct denomination and coinType (1875S Twenty Cent)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1875S Twenty Cent-XF
T300.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.denomination).toBe('20¢');
    expect(coin.coinType).toBe('Twenty Cent');
    expect(coin.mintMark).toBe('S');
    expect(coin.grade).toBe('XF');
  });

  it('parses 3CS with coinType Three Cent Silver (1861 3CS)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1861 3CS-AU
T50.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.denomination).toBe('3CS');
    expect(coin.coinType).toBe('Three Cent Silver');
  });

  it('parses 3CN with coinType Three Cent Nickel (1865 3CN)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1865 3CN-VF
T25.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.denomination).toBe('3CN');
    expect(coin.coinType).toBe('Three Cent Nickel');
  });

  it('infers coinType from year when no explicit name (1964 Quarter → Washington)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1964 Quarter
T5.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.coinType).toBe('Washington');
  });

  it('detects explicit coinType from security name (1921 Morgan Dollar)', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1921 Morgan Dollar MS63
T50.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.coinType).toBe('Morgan');
    expect(coin.denomination).toBe('$1');
  });

  it('skips year-only security names with no denomination', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1934
T25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.rejectedRecords).toHaveLength(1);
  });

  it('skips bare year-only rows even when they have a dollar value', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y2025
T25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.rejectedRecords).toHaveLength(1);
  });

  it('prefers Morgan for ambiguous 1880/1881 $1 entries', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1880-S $1 - ANACS MS63 Cameo PL
T250.00
^
D01/16/2024
NBuy
Y1881-S $1 - ANACS MS64
T250.00
^
`;

    const result = service.parse(qif);
    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].coinType).toBe('Morgan');
    expect(result.importedRecords[1].coinType).toBe('Morgan');
  });

  it('preserves overdate year strings like 1862/1', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1862/1 Half Dollar
T25.00
^
`;

    const result = service.parse(qif);
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].year).toBe('1862/1');
    expect(result.importedRecords[0].denomination).toBe('50¢');
  });

  it('keeps zero-cost dollar entries importable when they have a valid denomination', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1880-S Morgan Dollar
T0.00
^
D01/16/2024
NBuy
Y1881-S Morgan Dollar
T0.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].denomination).toBe('$1');
    expect(result.importedRecords[1].denomination).toBe('$1');
    expect(result.importedRecords[0].purchasePrice).toBe(0);
    expect(result.importedRecords[1].purchasePrice).toBe(0);
  });

  it('prefers descriptive commemorative names over date-based walking liberty inference', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1934D 50C Oregon
T25.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.coinType).toBe('Oregon Trail');
    expect(coin.denomination).toBe('50¢');
    expect(coin.mintMark).toBe('D');
  });

  it('imports 1880-S and 1881-S Morgan dollars with the correct mint mark', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1880-S Morgan Dollar
T250.00
^
D01/16/2024
NBuy
Y1881-S Morgan Dollar
T250.00
^
`;

    const result = service.parse(qif);
    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].year).toBe('1880');
    expect(result.importedRecords[0].mintMark).toBe('S');
    expect(result.importedRecords[1].year).toBe('1881');
    expect(result.importedRecords[1].mintMark).toBe('S');
  });

  it('prefers explicit Cap & Rays issue names over generic year inference', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1822 Cap & Rays 8 Reales VF
T125.00
^
`;
    const result = service.parse(qif);
    const coin = result.importedRecords[0];
    expect(coin.coinType).toBe('Cap & Rays');
    expect(coin.denomination).toBe('8 Reales');
  });

  // The 2-of-3 main-detail rule (Year / Coin Type / Denomination).
  //
  // Without it a coin described by a year alone is imported and then
  // rejected by the backend with `400 {"error":"denomination is required"}`.

  describe('main-detail presence helper', () => {
    it('treats a populated value as present', () => {
      expect(isCoinDetailPresent('1921')).toBe(true);
      expect(isCoinDetailPresent('Morgan')).toBe(true);
      expect(isCoinDetailPresent('50¢')).toBe(true);
    });

    it('does not treat empty, whitespace-only, or null values as present', () => {
      expect(isCoinDetailPresent('')).toBe(false);
      expect(isCoinDetailPresent(' ')).toBe(false);
      expect(isCoinDetailPresent('   \t  ')).toBe(false);
      expect(isCoinDetailPresent(' ')).toBe(false); // non-breaking space
      expect(isCoinDetailPresent(undefined)).toBe(false);
      expect(isCoinDetailPresent(null)).toBe(false);
    });

    it('does not treat placeholder values as present', () => {
      for (const placeholder of ['0', '0000', '-', '--', 'N/A', 'n/a', 'None', 'UNKNOWN', 'null', 'TBD', '?']) {
        expect(isCoinDetailPresent(placeholder), `"${placeholder}" should not count`).toBe(false);
      }
    });

    it('rejects a coin whose details are only whitespace or placeholders', () => {
      const check = checkMainCoinDetails({ year: '1934', coinType: '  ', denomination: 'Unknown' });
      expect(check.passes).toBe(false);
      expect(check.present).toEqual(['Year']);
      expect(check.missing).toEqual(['Coin Type', 'Denomination']);
    });
  });

  it('imports a coin with exactly 2 of the 3 main details', () => {
    const service = new QuickenImportService();
    // No year in the security name, but Coin Type (Morgan) and
    // Denomination ($1) are both present -- 2 of 3, so it qualifies.
    const qif = `!Type:Invst
D01/15/2024
NBuy
YMorgan Dollar MS63
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.rejectedRecords).toHaveLength(0);
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].year).toBe('');
    expect(result.importedRecords[0].coinType).toBe('Morgan');
    expect(result.importedRecords[0].denomination).toBe('$1');
  });

  it('imports a coin with all 3 main details', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1921 Morgan Dollar MS63
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.rejectedRecords).toHaveLength(0);
    expect(result.importedRecords).toHaveLength(1);
  });

  it('excepts a year-only coin with a reason naming the missing details', () => {
    const service = new QuickenImportService();
    // A row carrying nothing but a year.
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1943 Steel
T25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.rejectedRecords).toHaveLength(1);

    const exception = result.rejectedRecords[0];
    expect(exception.securityName).toBe('1943 Steel'); // raw QIF security name
    expect(exception.present).toEqual(['Year']);
    expect(exception.missing).toEqual(['Coin Type', 'Denomination']);
    expect(exception.reason).toBe(
      'Only 1 of 3 required details found: Year. Missing: Coin Type, Denomination.'
    );
    // The partially-parsed record is kept so the user can review / override it.
    expect(exception.record.year).toBe('1943');
    expect(exception.record.purchasePrice).toBe(25);
  });

  it('excepts a coin with none of the 3 main details rather than dropping it', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
YMiscellaneous Holder
T25.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0].reason).toBe(
      'Only 0 of 3 required details found: none. Missing: Year, Coin Type, Denomination.'
    );
  });

  it('separates imported, excepted, and net-quantity-skipped coins in one parse', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1921 Morgan Dollar MS63
T50.00
^
D01/16/2024
NBuy
Y1943 Steel
T25.00
^
D01/17/2024
NBuy
Y1964 Quarter
T5.00
^
D02/20/2024
NSell
Y1964 Quarter
T6.00
^
`;

    const result = service.parse(qif, undefined, undefined, { excludeSold: true });

    // Held and fully detailed -> imported
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].coinType).toBe('Morgan');

    // Held but under-detailed -> exception (visible, not silently dropped)
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0].securityName).toBe('1943 Steel');

    // Bought then sold, and the caller asked for held coins only
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.skippedRecords[0].denomination).toBe('25¢');
  });

  it('separates imported and excepted coins with the sold ones left in', () => {
    /* The same file as above with the tick box UNTICKED, which is the
     * default. The sold quarter now imports and is named as sold; the
     * under-detailed row is still an exception, because being sold has
     * never been a reason to waive the 2-of-3 rule. */
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1921 Morgan Dollar MS63
T50.00
^
D01/16/2024
NBuy
Y1943 Steel
T25.00
^
D01/17/2024
NBuy
Y1964 Quarter
T5.00
^
D02/20/2024
NSell
Y1964 Quarter
T6.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords.map(r => r.denomination).sort()).toEqual(['$1', '25¢']);
    expect(result.rejectedRecords.map(r => r.securityName)).toEqual(['1943 Steel']);
    expect(result.skippedRecords).toEqual([]);
    expect(result.soldSecurityNames).toEqual(['1964 Quarter']);
  });

  it('does not except a coin that was already sold -- net quantity wins', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1943 Steel
T25.00
^
D02/20/2024
NSell
Y1943 Steel
T30.00
^
`;

    const result = service.parse(qif, undefined, undefined, { excludeSold: true });

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.rejectedRecords).toHaveLength(0);
  });

  it('DOES except a sold coin once the sold filter is off', () => {
    /* The order of the two gates, made visible. With the sold filter off
     * there is no first gate to swallow the row, so the 2-of-3 rule judges
     * it like any other -- and "1943 Steel" carries only a year. It lands
     * in the exceptions panel the user can see rather than disappearing,
     * which is the whole reason that panel exists. */
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1943 Steel
T25.00
^
D02/20/2024
NSell
Y1943 Steel
T30.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(0);
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.soldSecurityNames).toEqual(['1943 Steel']);
  });

  it('normalizes an ISO-formatted QIF date instead of reading it as M/D/Y', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-02-01
NBuy
Y1921 Morgan Dollar MS63
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords[0].purchaseDate).toBe('2024-02-01');
  });

  it('does not confuse Half Cent with Half Dollar', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1853 Half Cent
T200.00
^
D01/16/2024
NBuy
Y1853 Half Dollar
T100.00
^
`;
    const result = service.parse(qif);
    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].denomination).toBe('½¢');
    expect(result.importedRecords[1].denomination).toBe('50¢');
  });

   /*
   * CERTIFICATION COMPANY  +  CAC STICKER
   *
   * The security names used below are copied (or lightly trimmed) from the
   * collection's real Quicken export, so these tests describe the shapes the
   * parser genuinely has to cope with -- not invented ones.
   *
   * Two things are being protected here:
   *   1. Whole-token matching. "NGC" must be its own word, never a fragment of
   *      a longer one.
   *   2. The CAC vs CACG distinction. CAC is a green STICKER stuck on someone
   *      else's slab; CACG is CAC's own GRADING SERVICE. They mean different
   *      things and must never be confused for one another.
    */
  describe('certification company and CAC sticker', () => {
    /**
     * Wraps a security name in the smallest valid QIF transaction and returns
     * the single parsed record. Keeps each assertion below to one line instead
     * of ten lines of QIF boilerplate.
     */
    function parseSecurityName(securityName: string) {
      const service = new QuickenImportService();
      const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
      const result = service.parse(qif);
      // Every fixture here carries 2+ main details, so it should be imported
      // rather than diverted to the exceptions list.
      expect(result.importedRecords).toHaveLength(1);
      return result.importedRecords[0];
    }

    // --- Every company token, one at a time -------------------------------
    // PCGS / NGC / ANACS / ICG are the four that actually occur in this
    // collection's QIF; SEGS / CACG / NNC are supported because the user
    // owns coins from them that are not yet in the export.
    const companyCases: { name: string; expected: string }[] = [
      { name: '1927 $20 - PCGS MS64',   expected: 'PCGS' },
      { name: '1904 $20 - NGC MS63',    expected: 'NGC' },
      { name: '1898-O $1 - ANACS MS65', expected: 'ANACS' },
      { name: '1886 $1 - ICG MS64',     expected: 'ICG' },
      { name: '1875 20¢ - SEGS XF40',   expected: 'SEGS' },
      { name: '1875 20¢ - CACG MS65',   expected: 'CACG' },
      { name: '1875 20¢ - NNC AU50',    expected: 'NNC' },
    ];

    for (const testCase of companyCases) {
      it(`reads certCompany "${testCase.expected}" from "${testCase.name}"`, () => {
        expect(parseSecurityName(testCase.name).certCompany).toBe(testCase.expected);
      });
    }

    it('matches a company token written in lower case', () => {
      // Quicken security names are hand-typed, so casing is not reliable.
      // The stored value is always the canonical upper-case token.
      expect(parseSecurityName('1927 $20 - pcgs MS64').certCompany).toBe('PCGS');
    });

    it('matches a company token separated by a hyphen or a slash, not just a space', () => {
      // Both of these appear verbatim in the real export.
      expect(parseSecurityName('1908 $20-PCGS MS63').certCompany).toBe('PCGS');
      expect(parseSecurityName('1838 Reeded 50¢-XF (CLEANED/PCGS)').certCompany).toBe('PCGS');
    });

    it('does not match NGC inside a longer word', () => {
      // The whole-token rule's whole reason for existing: a substring search
      // would have found "NGC" in the middle of "RINGCASE" and wrongly
      // credited the coin to NGC.
      const coin = parseSecurityName('1921 Morgan Dollar RINGCASE MS63');
      expect(coin.certCompany).toBe('');
    });

    it('leaves certCompany empty and hasCacSticker false when the name names neither', () => {
      const coin = parseSecurityName('1921 Morgan Dollar MS63');
      expect(coin.certCompany).toBe('');
      // Explicitly false, never undefined -- the database column is
      // BIT NOT NULL and the UI binds a checkbox to it.
      expect(coin.hasCacSticker).toBe(false);
      expect(coin.hasCacSticker).not.toBeUndefined();
    });

    // --- The grade must survive an adjacent company token -----------------
    // A grade almost always sits immediately after the company, so this is
    // where a careless implementation (one that stripped the company out of
    // the string, say) would eat part of the grade.
    it('does not corrupt a grade that sits right after the company', () => {
      expect(parseSecurityName('1927 $20 - PCGS MS64').grade).toBe('MS64');
      expect(parseSecurityName('1875 20¢ - ANACS VG8').grade).toBe('VG8');
      expect(parseSecurityName('1876 20¢ - PCGS/CAC XF45').grade).toBe('XF45');
      // The designation is now captured too (see the designation tests below),
      // and the separator is normalised away.
      expect(parseSecurityName('1982 Israel 5 Shilling - ANACS PF69 DCAM').grade).toBe('PF69DCAM');
    });

    // --- Grade designations ------------------------------------------------
    // Proof and copper coins are graded with a designation suffix. A grade
    // expression terminated with `\b` loses them: in "PF65RB" there is no
    // word boundary between "5" and "R", so the whole match fails.
    it('captures numeric grades that carry a designation suffix', () => {
      const cases: [string, string][] = [
        ['1870 1¢ - NGC PF65RB', 'PF65RB'],            // red-brown
        ['1867 3CS - NGC PF64Cameo', 'PF64CAMEO'],     // cameo, no separator
        ['1867 3CS - NGC PF64 Cameo', 'PF64CAMEO'],    // cameo, spaced
        ['1884 3CN - PCGS PF65CAM', 'PF65CAM'],
        // "Israel" alone is not a denomination, so this fixture needs the
        // unit spelled out to clear the 2-of-3 completeness rule the helper
        // asserts on.
        ['1982 Israel 5 Shilling - ANACS PF69DCAM', 'PF69DCAM'],  // deep cameo
        ['1886 $1 - ICG MS64DMPL', 'MS64DMPL'],        // deep mirror prooflike
        ['1938 5¢ - PCGS MS70-FS', 'MS70FS'],          // full steps
      ];
      for (const [name, expected] of cases) {
        expect(parseSecurityName(name).grade, name).toBe(expected);
      }
    });

    it('keeps the plus modifier on a grade', () => {
      // "+" is not a word character, so the old `\b`-terminated expression
      // dropped it. These must not regress to a bare numeric grade.
      expect(parseSecurityName('1870 $1 - PCGS/CAC PF62+').grade).toBe('PF62+');
      expect(parseSecurityName('1927 $20 - PCGS MS64+').grade).toBe('MS64+');
    });

    it('still parses plain grades exactly as before', () => {
      // The fallback pass must keep every previously working form working.
      expect(parseSecurityName('1906-S $5 - XF').grade).toBe('XF');
      expect(parseSecurityName('1871 3CN - AU53').grade).toBe('AU53');
      expect(parseSecurityName('1875 20¢ - VG8').grade).toBe('VG8');
      expect(parseSecurityName('1852 3CS - CH+AU').grade).toBe('CH+AU');
      expect(parseSecurityName('1873 3CN - VF/EF').grade).toBe('VF/EF');
    });

    it('does not invent a designation from surrounding words', () => {
      // "(CLEANED)" and similar trailing text must not be absorbed into the
      // grade, and must not prevent the grade from being found.
      expect(parseSecurityName('1852 3CS ANACS AU53 (CLEANED)').grade).toBe('AU53');
      expect(parseSecurityName('1838 Reeded 50¢-XF (CLEANED/PCGS)').grade).toBe('XF');
    });

    it('extracts exactly the same grade with or without a company token present', () => {
      // A behaviour-independent guard: whatever the grade regex makes of
      // these suffixes, adding the company in front must not change it.
      // (Some of these grades -- "PF65RB", "PF64Cameo" -- the grade regex
      // does not recognise at all; the point here is that company detection
      // neither helps nor hurts.)
      const pairs: { withCompany: string; without: string }[] = [
        { withCompany: '1870 1¢ - NGC PF65RB',    without: '1870 1¢ - PF65RB' },
        { withCompany: '1867 3CS - NGC PF64Cameo', without: '1867 3CS - PF64Cameo' },
        { withCompany: '1884 3CN - PCGS PF65CAM',  without: '1884 3CN - PF65CAM' },
      ];

      for (const pair of pairs) {
        expect(parseSecurityName(pair.withCompany).grade)
          .toBe(parseSecurityName(pair.without).grade);
      }
    });

    // --- CAC sticker ------------------------------------------------------
    // "PCGS/CAC" and "NGC/CAC" are by far the most common forms in the real
    // export; the rest are spellings the user has used elsewhere.
    const cacCases = [
      '1909 S-VDB 1¢ - PCGS/CAC AU58',
      '1835 $5 - NGC/CAC XF45',
      '1875 20¢ - CAC XF40',
      "1875 20¢ - PCGS XF40 CAC'd",
      '1875 20¢ - PCGS XF40 CACd',
      '1875 20¢ - PCGS XF40 w/CAC',
      '1875 20¢ - PCGS XF40 +CAC',
      '1875 20¢ - PCGS XF40 (CAC)',
      '1875 20¢ - PCGS XF40 CAC Gold',
      '1875 20¢ - PCGS XF40 Gold CAC',
    ];

    for (const name of cacCases) {
      it(`sets hasCacSticker for "${name}"`, () => {
        expect(parseSecurityName(name).hasCacSticker).toBe(true);
      });
    }

    it('still reads the grading company when a CAC sticker is also present', () => {
      // "PCGS/CAC" means "PCGS slab, CAC sticker" -- both facts, not one.
      const coin = parseSecurityName('1909 S-VDB 1¢ - PCGS/CAC AU58');
      expect(coin.certCompany).toBe('PCGS');
      expect(coin.hasCacSticker).toBe(true);
      expect(coin.grade).toBe('AU58');
    });

    it('treats CACG as the grading company and NOT as a CAC sticker', () => {
      // THE trap this feature has to avoid. CACG is CAC's grading service;
      // a CACG slab is not a CAC-stickered slab.
      const coin = parseSecurityName('1875 20¢ - CACG MS65');
      expect(coin.certCompany).toBe('CACG');
      expect(coin.hasCacSticker).toBe(false);
    });

    it('sets both fields when a CACG coin also carries a CAC sticker', () => {
      // Belt and braces: the two rules are independent, so an explicit CAC
      // token still registers even next to CACG.
      const coin = parseSecurityName('1875 20¢ - CACG MS65 (CAC)');
      expect(coin.certCompany).toBe('CACG');
      expect(coin.hasCacSticker).toBe(true);
    });

    it('does not mistake Quicken\'s "W/C" (with cents) shorthand for a CAC sticker', () => {
      // Real name from the export: "1883 5¢ W/C-NGC PF65" means the 1883
      // Liberty nickel WITH the word CENTS. It is not a CAC coin.
      const coin = parseSecurityName('1883 5¢ W/C-NGC PF65');
      expect(coin.hasCacSticker).toBe(false);
      expect(coin.certCompany).toBe('NGC');
    });

    it('does not let a slab label alone satisfy the 2-of-3 main-detail rule', () => {
      // Cert company and CAC are NOT main details. A row describing only the
      // slab still has to be surfaced as an exception, exactly as before.
      const service = new QuickenImportService();
      const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY1943 PCGS/CAC MS65\nT100.00\n^\n`;

      const result = service.parse(qif);

      expect(result.importedRecords).toHaveLength(0);
      expect(result.rejectedRecords).toHaveLength(1);
      expect(result.rejectedRecords[0].missing).toContain('Denomination');
      // The fields were still parsed -- they just do not count toward the rule.
      expect(result.rejectedRecords[0].record.certCompany).toBe('PCGS');
      expect(result.rejectedRecords[0].record.hasCacSticker).toBe(true);
    });

    it('carries both new fields through a full multi-coin parse', () => {
      const service = new QuickenImportService();
      const qif =
        `!Type:Invst\nD01/15/2024\nNBuy\nY1927 $20 - PCGS MS64\nT2000.00\n^\n` +
        `!Type:Invst\nD01/16/2024\nNBuy\nY1835 $5 - NGC/CAC XF45\nT1500.00\n^\n` +
        `!Type:Invst\nD01/17/2024\nNBuy\nY1921 Morgan Dollar MS63\nT50.00\n^\n`;

      const result = service.parse(qif);

      expect(result.importedRecords).toHaveLength(3);
      expect(result.importedRecords.map(r => r.certCompany)).toEqual(['PCGS', 'NGC', '']);
      expect(result.importedRecords.map(r => r.hasCacSticker)).toEqual([false, true, false]);
    });
  });

  /* =========================================================================
   * NAMES WHOSE DENOMINATION IS NOT WRITTEN AS A FACE VALUE
   * -------------------------------------------------------------------------
   * Every name below is a REAL security out of a QIF export, not an invented
   * probe. The rules being pinned:
   *
   *   Silver Eagle is $1; a (Gold) Eagle is $10, a Double Eagle $20, a Half
   *   Eagle $5 and a Quarter Eagle $2.50. The modern Gold Eagle is the $50
   *   bullion coin, told apart by its year -- it has only been struck since
   *   1986.
   *
   * This is deliberately ONE table rather than a file or a describe-block per
   * coin: the rules are general, so the cases that exercise them belong
   * together, and a new one is a new row.
   * ======================================================================= */
  describe('denominations that need more than a face value to read', () => {
    const parseOne = (securityName: string) => {
      const service = new QuickenImportService();
      const result = service.parse(
        `!Type:Invst
D01/15/2024
NBuy
Y${securityName}
T100.00
^
`
      );
      return [...result.importedRecords, ...result.rejectedRecords.map(r => r.record)][0];
    };

    const cases: ReadonlyArray<readonly [name: string, denomination: string, why: string]> = [
      // --- silver, which must be asked about before the bare "Eagle" test ---
      ['1987 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2006 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2008 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2025 250th Anniversary U.S. Army ASE', '$1', 'ASE is the American Silver Eagle'],

      // --- the classic gold eagles, whose readings must NOT have changed ---
      ['1907 Double Eagle - PCGS MS63', '$20', 'double eagle still wins over eagle'],
      ['1901S Eagle - NGC AU58', '$10', 'a bare gold Eagle is still ten dollars'],

      // --- the modern one-ounce gold, settled by its year ---
      ['1986S Au $50-PF', '$50', 'explicit $50 face value, previously unreadable'],
      ['2025 $50 Gold Buffalo - NGC MS70 FR', '$50', 'explicit $50 face value'],

      // --- initialisms the owner writes with no other denomination word ---
      ['1995 SBA - BU', '$1', 'SBA is the Susan B. Anthony dollar'],
      ['1999 SBA - PF', '$1', 'the grade suffix must not change the reading'],
      ['2011 5oz. ATB Vicksburg', '25¢', 'every America the Beautiful coin is a quarter'],
      ['2011 5oz. ATB Glacier NP - PCGS MS69DMPL', '25¢', 'five ounces of silver, still a quarter'],
    ];

    for (const [name, denomination, why] of cases) {
      it(`reads "${name}" as ${denomination} -- ${why}`, () => {
        expect(parseOne(name).denomination).toBe(denomination);
      });
    }

    /* A SET is the one eagle that gets NO denomination, on purpose.
     *
     * "1987 2-coin Proof American Gold Eagle Set (1.5 troy oz.)" is a $50 and
     * a $25 in a single holding. There is no single right answer, so the
     * importer declines to invent one and the row goes to the exceptions
     * list where the owner can say what he means. Guessing here would be the
     * same class of silent damage as the ½10¢ half dimes. */
    it('refuses to pick a denomination for a multi-coin Gold Eagle set', () => {
      const record = parseOne('1987 2-coin Proof American Gold Eagle Set (1.5 troy oz.)');
      expect(record.denomination).toBe('');
    });

    /* The sheqalim rule, and the guard that keeps it from spreading.
     *
     * The owner confirmed both the reading and that the coin is 90% gold.
     * The denomination is settled here; the metal is NOT, because the name
     * never says "gold" and no reference row covers an Israeli commemorative
     * -- see the note in the README about what still has to be typed in. */
    it('reads Israeli sheqalim written as a bare S', () => {
      expect(parseOne('1982 Israel Qumran 5S - ANACS PF69DCAM').denomination)
        .toBe('5 Sheqalim');
    });

    it('will not read a bare S as sheqalim when the name does not say Israel', () => {
      // "5S" here is a mintmark-shaped token on an American coin. Reading it
      // as a foreign denomination would be exactly the over-reach the guard
      // exists to prevent.
      expect(parseOne('1885 5S Morgan Dollar - PCGS MS63').denomination).toBe('$1');
    });
  });

  /* =========================================================================
   * READINGS THE PARSER IS NOT SURE ABOUT
   * -------------------------------------------------------------------------
   * The three-cent piece is the first and, today, the only caller of the
   * ambiguous-reading channel (`AmbiguousReading` in coin.model.ts), so this
   * is where that channel gets exercised end to end. It is NOT a file, or a
   * describe block, about three-cent coins: there is deliberately no
   * per-denomination machinery in this project, because the rules are general
   * and a file per denomination would be pure noise.
   *
   * WHAT IS BEING PINNED
   *   1. The two CERTAIN bands answer, and answer without a flag:
   *      1851-1864 is silver-only, 1874-1889 is nickel-only.
   *   2. The OVERLAP, 1865-1873, still answers -- a guess is not a refusal
   *      and the row must still import -- but it carries the flag.
   *   3. Inside the overlap the tie-break is scarcity with proofs as the
   *      exception: three-cent silver business strikes after 1862 are very
   *      scarce, so proof means silver and anything else means nickel.
   *   4. A name that SPELLS OUT 3CS or 3CN is never flagged. There is
   *      nothing to be unsure about.
   *   5. The user's answer, fed back in, moves the denomination AND
   *      everything derived from it.
   *
   * One table, one row per case, per the convention set by the denomination
   * table above.
   * ======================================================================= */
  describe('ambiguous readings are answered, flagged and correctable', () => {
    /** Parse one security name; works whether it imports or is excepted. */
    const parseOne = (securityName: string) => {
      const service = new QuickenImportService();
      const result = service.parse(
        `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`
      );
      return [...result.importedRecords, ...result.rejectedRecords.map(r => r.record)][0];
    };

    /** The denomination flag on a record, or undefined when it was certain. */
    const flagOf = (securityName: string) =>
      parseOne(securityName).ambiguities?.find(a => a.field === 'denomination');

    interface ThreeCentCase {
      /** The Quicken security name, written the way a bare reading looks. */
      name: string;
      /** What the importer should settle on. */
      denomination: string;
      /** True when that answer is a guess and has to say so. */
      flagged: boolean;
      /** Why this row is in the table. */
      why: string;
    }

    const cases: ThreeCentCase[] = [
      // --- CERTAIN: before the nickel existed ------------------------------
      { name: '1851 3¢ - EF', denomination: '3CS', flagged: false,
        why: 'first year of the silver; the nickel is fourteen years away' },
      { name: '1862 3¢ - XF45', denomination: '3CS', flagged: false,
        why: 'still silver-only, so the scarcity rule never has to be consulted' },
      { name: '1864 3¢ - PCGS PF64', denomination: '3CS', flagged: false,
        why: 'last silver-only year -- certain even though it is a proof' },

      // --- THE OVERLAP: a guess, and it has to admit it --------------------
      { name: '1865 3¢ - VF30', denomination: '3CN', flagged: true,
        why: 'first year of the overlap; nothing says proof, so the common nickel' },
      { name: '1870 3¢ - AU', denomination: '3CN', flagged: true,
        why: 'mid-overlap circulated coin; silver business strikes are very scarce by now' },
      { name: '1873 3¢ - VF/EF', denomination: '3CN', flagged: true,
        why: 'last year of the overlap, still genuinely ambiguous' },
      { name: '1865 3¢ - PCGS PF64', denomination: '3CS', flagged: true,
        why: 'the proof exception, read off the grade' },
      { name: '1868 3¢ - PCGS PR65', denomination: '3CS', flagged: true,
        why: 'PR and PF are the same statement; proof-strike.ts knows both' },
      { name: '1872 3¢ - NGC PF65 Cameo', denomination: '3CS', flagged: true,
        why: 'a designation suffix must not stop the grade reading as a proof' },
      { name: '1870 three cent - Proof', denomination: '3CS', flagged: true,
        why: 'the WORD proof, with no grade at all, is equally a statement' },
      { name: '1871 3c - MS63 Prooflike', denomination: '3CN', flagged: true,
        why: 'PROOFLIKE IS NOT A PROOF -- the trap proof-strike.ts exists to avoid' },

      // --- CERTAIN: after the silver ended ---------------------------------
      { name: '1874 3¢ - AU', denomination: '3CN', flagged: false,
        why: 'first nickel-only year' },
      { name: '1889 3¢ - NGC PF65 Cameo', denomination: '3CN', flagged: false,
        why: 'last year of the nickel; a proof proves nothing here, the date settles it' },

      // --- NOT AMBIGUOUS AT ALL: the name says which -----------------------
      { name: '1870 3CS - NGC PF64', denomination: '3CS', flagged: false,
        why: 'spelled out, inside the overlap -- nothing left to guess' },
      { name: '1870 3CN - AU', denomination: '3CN', flagged: false,
        why: 'spelled out the other way, same year' },
      { name: '1867 Three Cent Nickel - AU', denomination: '3CN', flagged: false,
        why: 'spelled out in words rather than the abbreviation' }
    ];

    it.each(cases)(
      '$name -> $denomination (flagged: $flagged) -- $why',
      ({ name, denomination, flagged }) => {
        const record = parseOne(name);
        expect(record.denomination).toBe(denomination);
        expect(record.ambiguities?.some(a => a.field === 'denomination') ?? false).toBe(flagged);
      }
    );

    it('still imports an ambiguous row -- a guess is not a rejection', () => {
      const service = new QuickenImportService();
      const result = service.parse(
        `!Type:Invst\nD01/15/2024\nNBuy\nY1870 3¢ - AU\nT100.00\n^\n`
      );
      // Dropping the record was one of the two alternatives the owner
      // rejected. It belongs in importedRecords, never in the exceptions.
      expect(result.importedRecords).toHaveLength(1);
      expect(result.rejectedRecords).toHaveLength(0);
      expect(result.importedRecords[0].ambiguities).toHaveLength(1);
    });

    it('carries both candidates and a readable reason on the flag', () => {
      const flag = flagOf('1870 3¢ - AU');
      expect(flag).toBeDefined();
      expect(flag!.chosen).toBe('3CN');
      // Both members, always -- so the preview can offer the one that was NOT
      // picked without having to work out for itself what it is.
      expect([...flag!.alternatives].sort()).toEqual(['3CN', '3CS']);
      // The sentence is read by the owner, not by a developer: it has to name
      // the overlap and say what the assumption rests on.
      expect(flag!.why).toContain('1865-1873');
      expect(flag!.why).toMatch(/scarce/i);
    });

    it('explains the proof exception when it is the proof branch that fired', () => {
      const flag = flagOf('1868 3¢ - PCGS PR65');
      expect(flag!.chosen).toBe('3CS');
      expect(flag!.why).toMatch(/proof/i);
    });

    it('treats a three-cent name with no year as maximally ambiguous', () => {
      // No year means the whole 1851-1889 span is open, so the same tie-break
      // and the same flag apply. This pins behaviour rather than describing a
      // real security: every three-cent name in the corpus spells out 3CS
      // or 3CN.
      const record = parseOne('3¢ - VF');
      expect(record.denomination).toBe('3CN');
      const flag = record.ambiguities?.find(a => a.field === 'denomination');
      expect(flag).toBeDefined();
      expect(flag!.why).toContain('1851-1889');
    });

    it('leaves every unambiguous coin with no flag at all', () => {
      // `ambiguities` is undefined -- not [] -- on an ordinary record, so
      // `record.ambiguities?.length` stays an honest test everywhere else.
      expect(parseOne('1927 $20 - PCGS MS64').ambiguities).toBeUndefined();
      expect(parseOne('1921 Morgan Dollar MS63').ambiguities).toBeUndefined();
    });

    it('carries the raw security name so a preview row has a stable identity', () => {
      // `id` is a fresh UUID on every parse, so the import modal keys the
      // user's answers on this instead.
      expect(parseOne('1870 3¢ - AU').securityName).toBe('1870 3¢ - AU');
    });

    /* -----------------------------------------------------------------------
     * THE USER'S ANSWER, AND WHAT IT HAS TO DRAG ALONG WITH IT.
     *
     * Fixing the choice cannot mean overwriting one string. The coin type and
     * the five alloy / weight fields are all DERIVED from the denomination --
     * an 1870 three-cent silver is 90% silver weighing 0.75 g, while the
     * three-cent nickel is copper-nickel with no precious metal in it at all
     * -- so the answer has to go back through the parser rather than being
     * painted onto its output.
     * --------------------------------------------------------------------- */
    const overlapQif = `!Type:Invst\nD01/15/2024\nNBuy\nY1870 3¢ - AU\nT100.00\n^\n`;

    it('re-derives coin type and alloy when the user picks the other candidate', () => {
      const service = new QuickenImportService();

      const guessed = service.parse(overlapQif).importedRecords[0];
      expect(guessed.denomination).toBe('3CN');
      expect(guessed.coinType).toBe('Three Cent Nickel');
      // Copper-nickel: no precious metal, so no purity.
      expect(guessed.pmPercent).toBeUndefined();

      const corrected = service.parse(overlapQif, undefined, { '1870 3¢ - AU': '3CS' })
        .importedRecords[0];
      expect(corrected.denomination).toBe('3CS');
      // The two fields that would have been left lying about the coin if the
      // caller had simply overwritten `denomination` on the finished record.
      expect(corrected.coinType).toBe('Three Cent Silver');
      expect(corrected.pmPercent).toBe(90);
      // The flag stays -- the reading really WAS ambiguous -- but it now
      // reports what is actually on the record.
      expect(corrected.ambiguities?.[0].chosen).toBe('3CS');
    });

    it('ignores a choice for a value the parser never offered', () => {
      const service = new QuickenImportService();
      const record = service.parse(overlapQif, undefined, { '1870 3¢ - AU': '$20' })
        .importedRecords[0];
      // Correcting a guess is not the same thing as free-text editing the
      // import, and must not quietly become it.
      expect(record.denomination).toBe('3CN');
    });

    it('ignores a choice aimed at a reading that was never ambiguous', () => {
      const service = new QuickenImportService();
      const certain = `!Type:Invst\nD01/15/2024\nNBuy\nY1927 $20 - PCGS MS64\nT100.00\n^\n`;
      const record = service.parse(certain, undefined, { '1927 $20 - PCGS MS64': '3CS' })
        .importedRecords[0];
      expect(record.denomination).toBe('$20');
    });

    it('ignores a stale choice keyed on a security that is no longer there', () => {
      const service = new QuickenImportService();
      const record = service.parse(overlapQif, undefined, { 'some other coin': '3CS' })
        .importedRecords[0];
      expect(record.denomination).toBe('3CN');
    });
  });

});

/*
 * WHAT A QIF SAYS ABOUT A SALE, AND WHERE IT ENDS UP.
 *
 * A Quicken investment account has no "sold" column. It has a Buy and,
 * later, a Sell / SellX / ShrsOut, and the importer reads a disposal off
 * the NET QUANTITY -- that is the honest reading of the document and it
 * stays the detector.
 *
 * What changed is that the detection is no longer the end of it. The
 * disposal block carries a date and usually an amount, and those are the
 * coin's Sold Date and Sold Price. Writing them onto the record is what
 * lets one rule -- "a coin counts as sold when it has a sold date, a sold
 * price or a buyer" (services/import-sold.ts) -- be true of a QIF import,
 * a CSV and a workbook alike. Before this, a QIF-imported coin was known to
 * be sold and had no sold date to show for it, and the user's filter had to
 * mean something different on that path.
 */


function qif(...blocks: string[][]): string {
  return blocks.map(lines => lines.join('\n')).join('\n^\n') + '\n^\n';
}

const BUY = (security: string, date = 'D01/15/2010', amount = 'T500.00') => [
  '!Type:Invst', date, 'NBuy', `Y${security}`, 'Q1', amount
];

function parseSold(text: string, excludeSold = false) {
  return new QuickenImportService().parse(text, undefined, undefined, { excludeSold });
}

function only(text: string) {
  const result = parseSold(text);
  expect(result.importedRecords).toHaveLength(1);
  return result.importedRecords[0];
}

describe('a coin the QIF says was sold', () => {
  it('arrives with the sale date from the Sell block', () => {
    const record = only(
      qif(BUY('1921 Morgan Dollar MS63'), [
        'D11/16/2013', 'NSell', 'Y1921 Morgan Dollar MS63', 'Q1', 'T700.00'
      ])
    );

    expect(record.soldDate).toBe('2013-11-16');
  });

  it('arrives with the proceeds as its sold price', () => {
    const record = only(
      qif(BUY('1921 Morgan Dollar MS63'), [
        'D11/16/2013', 'NSell', 'Y1921 Morgan Dollar MS63', 'Q1', 'T700.00'
      ])
    );

    expect(record.soldPrice).toBe(700);
  });

  it('reads a SellX the same way as a Sell', () => {
    const record = only(
      qif(BUY('1905 $20 - PCGS MS64'), [
        'D03/18/2014', 'NSellX', 'Y1905 $20 - PCGS MS64', 'Q1', 'T1500.00',
        'L[Alder Bank - Checking]'
      ])
    );

    expect(record.soldDate).toBe('2014-03-18');
    expect(record.soldPrice).toBe(1500);
  });

  it('takes the LATEST disposal when there is more than one', () => {
    const record = only(
      qif(
        BUY('1877 3CN - VF'),
        BUY('1877 3CN - VF', 'D02/01/2010'),
        ['D05/05/2011', 'NSell', 'Y1877 3CN - VF', 'Q1', 'T100.00'],
        ['D09/09/2015', 'NSell', 'Y1877 3CN - VF', 'Q1', 'T250.00']
      )
    );

    expect(record.soldDate).toBe('2015-09-09');
    expect(record.soldPrice).toBe(250);
  });
});

describe('a transfer out, which states no amount', () => {
  const transferred = () =>
    only(
      qif(BUY('1884 3CN - PCGS PF66'), [
        'D07/11/2004', 'NShrsOut', 'Y1884 3CN - PCGS PF66', 'Q1', 'MXfr To: Odd Type Set'
      ])
    );

  it('still gets a sold date, because the date is in the file', () => {
    expect(transferred().soldDate).toBe('2004-07-11');
  });

  it('GETS NO SOLD PRICE, rather than a price of zero', () => {
    /* 0 is a real sale price -- a coin given away -- and the import's sold
     * rule counts it as one. A ShrsOut between two Quicken accounts states
     * no amount at all, so claiming 0 would be putting a number in the
     * owner's record that his file never contained. */
    expect(transferred().soldPrice).toBeUndefined();
  });
});

describe('a coin still held', () => {
  it('has neither a sold date nor a sold price', () => {
    const record = only(qif(BUY('1881-S Morgan Dollar MS64')));

    expect(record.soldDate).toBeUndefined();
    expect(record.soldPrice).toBeUndefined();
  });

  it('keeps them undefined even after a partial disposal leaves one held', () => {
    const record = only(
      qif(
        BUY('1877 3CN - VF'),
        BUY('1877 3CN - VF', 'D02/01/2010'),
        ['D05/05/2011', 'NSell', 'Y1877 3CN - VF', 'Q1', 'T100.00']
      )
    );

    // Two bought, one sold: net 1, so the coin is still held and the sale
    // belongs to the one that left rather than to this record.
    expect(record.soldDate).toBeUndefined();
    expect(record.soldPrice).toBeUndefined();
  });
});

describe('"import only coins I still own"', () => {
  const text = qif(
    BUY('1921 Morgan Dollar MS63'),
    ['D11/16/2013', 'NSell', 'Y1921 Morgan Dollar MS63', 'Q1', 'T700.00'],
    BUY('1881-S Morgan Dollar MS64', 'D04/02/2011')
  );

  it('brings everything in when it is off, which is the default', () => {
    const result = parseSold(text);

    expect(result.importedRecords.map(r => r.securityName).sort()).toEqual([
      '1881-S Morgan Dollar MS64',
      '1921 Morgan Dollar MS63'
    ]);
    expect(result.skippedRecords).toEqual([]);
  });

  it('holds back the sold one when it is on, and says which', () => {
    const result = parseSold(text, true);

    expect(result.importedRecords.map(r => r.securityName)).toEqual([
      '1881-S Morgan Dollar MS64'
    ]);
    expect(result.skippedRecords.map(r => r.securityName)).toEqual([
      '1921 Morgan Dollar MS63'
    ]);
  });

  it('still reports the sold name either way', () => {
    expect(parseSold(text).soldSecurityNames).toEqual(['1921 Morgan Dollar MS63']);
    expect(parseSold(text, true).soldSecurityNames).toEqual(['1921 Morgan Dollar MS63']);
  });

  it('holds back a disposal with no date, which has nothing for the rule to read', () => {
    /* The belt-and-braces half of the gate. A `D`-less disposal block
     * leaves no sold date and no sold price, so the shared rule cannot see
     * it -- but Quicken still says the coin is gone, and a coin the user
     * asked to exclude must not slip back in on a technicality. */
    const result = parseSold(
      qif(BUY('1864 2¢'), ['NShrsOut', 'Y1864 2¢', 'Q1']),
      true
    );

    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords.map(r => r.securityName)).toEqual(['1864 2¢']);
  });
});

/*
 * quicken-payee-not-a-dealer.spec.ts
 *
 * WHAT THIS FILE PROVES
 *   That the QIF importer fills the transaction fields it can READ OFF THE
 *   FILE -- Purchase Date and Purchase Price from the Buy block, Sold Date
 *   and Sold Price from the disposal -- and fills NOTHING for the two
 *   counterparty fields, however dealer-like the `P` payee line looks.
 *
 * ---- WHY THE SECOND HALF IS A TEST AND NOT JUST A COMMENT ----
 *   `purchasedFrom` is a field a reader will eventually notice is empty on
 *   every Quicken-imported coin, go looking for the payee, find it sitting
 *   unused in the block, and "fix". The long THE PAYEE IS NOT A DEALER note
 *   in quicken-import.service.ts says why that is wrong; this file makes the
 *   fix fail.
 *
 *   The short version: in a Quicken INVESTMENT register the payee is
 *   routinely the account the transaction is filed against -- "Misc. Coins",
 *   "Odd Type Set" -- not the person who sold the coin. Written into
 *   Purchased From that is a wrong name on every coin, which the owner then
 *   has to clear one at a time. An empty field is visibly empty; a wrong one
 *   has to be noticed first.
 *
 * ---- THE CORPUS CANNOT REFEREE THIS, AND THAT IS THE POINT OF §3 ----
 *   `testing/qif-corpus/` puts an INVENTED DEALER on 84% of acquisition
 *   blocks (`DEALERS` in generate-corpus.mjs) and an account name on none of
 *   them. A payee -> Purchased From rule would therefore measure as 100%
 *   correct here and near 0% on the export this corpus stands in for. So §3
 *   measures what the importer DOES fill -- where the corpus is faithful --
 *   and records the two deliberate zeroes beside it.
 */


/** Fields the importer must never invent, whatever the file says. */
const NEVER_FILLED = ['purchasedFrom', 'soldTo', 'transactionNotes'] as const;

function parsePayee(qif: string) {
  return new QuickenImportService().parse(qif);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('1. what a Buy block honestly carries, and does', () => {
  it('fills Purchase Date and Purchase Price from the block itself', () => {
    // These two are not guesses: `D` is the date and `T` is the amount.
    const record = asRecord(parsePayee(
      '!Type:Invst\nD03/14/2014\nNBuy\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT158.33\n^\n'
    ).importedRecords[0]);

    expect(record['purchaseDate']).toBe('2014-03-14');
    expect(record['purchasePrice']).toBe(158.33);
  });

  it('fills Sold Date and Sold Price from the disposal block', () => {
    const record = asRecord(parsePayee(
      '!Type:Invst\n' +
      'D03/14/2014\nNBuy\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT158.33\n^\n' +
      'D07/06/2015\nNSell\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT242.26\n^\n'
    ).importedRecords[0]);

    expect(record['soldDate']).toBe('2015-07-06');
    expect(record['soldPrice']).toBe(242.26);
    // Which is what makes the shared rule answer the same way it would for
    // a spreadsheet row. See services/import-sold.ts.
    expect(isSoldRecord(record as never)).toBe(true);
  });
});

describe('2. the payee, which is never a counterparty', () => {
  it('writes nothing for a payee that looks exactly like a dealer', () => {
    // The hard case. "Kingsmere Numismatics" is indistinguishable from a
    // real dealer, and it is still not evidence: the same line in the same
    // position holds the account name on the file this rule exists for.
    const record = asRecord(parsePayee(
      '!Type:Invst\nD03/14/2014\nNBuyX\nY1881-S Morgan $1 - PCGS MS64\nQ1\n' +
      'T158.33\nPKingsmere Numismatics\nL[Alder Bank - Checking]\n$158.33\n^\n'
    ).importedRecords[0]);

    for (const field of NEVER_FILLED) {
      expect(record[field]).toBeUndefined();
    }
  });

  it('writes nothing for a payee that is plainly the account name', () => {
    const qif =
      '!Account\nNMisc. Coins\nTInvst\n^\n' +
      '!Type:Invst\nD03/14/2014\nNBuyX\nY1881-S Morgan $1 - PCGS MS64\nQ1\n' +
      'T158.33\nPMisc. Coins\n^\n';
    const record = asRecord(parsePayee(qif).importedRecords[0]);

    for (const field of NEVER_FILLED) {
      expect(record[field]).toBeUndefined();
    }
  });

  it('writes no buyer even when the SALE block names one', () => {
    // A sold coin is where a Sold To would be most tempting and most wrong:
    // on a SellX the payee is normally the account the proceeds went to.
    const record = asRecord(parsePayee(
      '!Type:Invst\n' +
      'D03/14/2014\nNBuyX\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT158.33\nPHarbourstone Coins\n^\n' +
      'D07/06/2015\nNSellX\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT242.26\nPTollgate Rarities\n^\n'
    ).importedRecords[0]);

    expect(record['soldTo']).toBeUndefined();
    expect(record['purchasedFrom']).toBeUndefined();
    // The half of the disposal that IS in the file is still read.
    expect(record['soldDate']).toBe('2015-07-06');
    expect(record['soldPrice']).toBe(242.26);
  });

  it('does not let a payee alone make a coin look sold', () => {
    // If a payee ever leaked into `soldTo`, every coin in the account would
    // satisfy the shared sold rule and "only coins I still own" would import
    // nothing. That is the blast radius, and it is why this is tested.
    const record = asRecord(parsePayee(
      '!Type:Invst\nD03/14/2014\nNBuy\nY1881-S Morgan $1 - PCGS MS64\nQ1\n' +
      'T158.33\nPKingsmere Numismatics\n^\n'
    ).importedRecords[0]);

    expect(isSoldRecord(record as never)).toBe(false);
  });

  it('leaves the transaction note empty while the memo still reaches Notes', () => {
    // Coins.Notes and Coins.TransactionNotes are two columns. The QIF memo
    // belongs to the first; nothing in the file belongs to the second.
    const record = asRecord(parsePayee(
      '!Type:Invst\nD03/14/2014\nNBuy\nY1881-S Morgan $1 - PCGS MS64\nQ1\n' +
      'T158.33\nMBought at the spring show\n^\n'
    ).importedRecords[0]);

    expect(record['notes']).toBe('Bought at the spring show');
    expect(record['transactionNotes']).toBeUndefined();
  });
});

/** Per-field fill counts over every account in the corpus. */
function census() {
  const counts: Record<string, number> = {
    total: 0, purchaseDate: 0, purchasePrice: 0, purchasedFrom: 0,
    soldDate: 0, soldPrice: 0, soldTo: 0, transactionNotes: 0
  };

  for (const account of QIF_ACCOUNTS) {
    const result = new QuickenImportService().parse(decodeQif(account.file), account.account);
    for (const imported of result.importedRecords) {
      const record = asRecord(imported);
      counts['total'] += 1;
      // Text fields are PRESENT only once trimmed, numbers are present at
      // 0 -- the same two readings services/import-sold.ts uses, so these
      // counts mean what the sold filter means.
      for (const field of ['purchaseDate', 'purchasedFrom', 'soldDate', 'soldTo', 'transactionNotes']) {
        const value = record[field];
        if (typeof value === 'string' && value.trim().length > 0) counts[field] += 1;
      }
      for (const field of ['purchasePrice', 'soldPrice']) {
        const value = record[field];
        if (typeof value === 'number' && Number.isFinite(value)) counts[field] += 1;
      }
    }
  }

  return counts;
}

const CORPUS = census();

describe('3. the whole corpus, field by field', () => {
  it('is a sample worth measuring', () => {
    // Non-vacuity, the same guard the other corpus specs open with: if the
    // fixture ever stops producing coins every count below goes to zero and
    // the two deliberate zeroes become indistinguishable from a broken run.
    expect(CORPUS['total']).toBe(457);
    expect(QIF_ACCOUNTS).toHaveLength(7);
  });

  it('fills both purchase fields on every single record', () => {
    // 457 of 457. `D` and the amount are on every acquisition block the
    // importer builds a record from, so there is no honest reason for
    // either of these to be short -- and the plan asked whether they were.
    expect(CORPUS['purchaseDate']).toBe(457);
    expect(CORPUS['purchasePrice']).toBe(457);
  });

  it('fills the sale fields only where the file recorded a disposal', () => {
    // 352 sold dates and 285 sold prices out of 457. The gap between the two
    // is real and must not be closed by inventing a 0: a ShrsOut transfer
    // carries a quantity and no amount, and 0 is a price that means "given
    // away" to services/import-sold.ts.
    expect(CORPUS['soldDate']).toBe(352);
    expect(CORPUS['soldPrice']).toBe(285);
  });

  it('fills NEITHER counterparty, nor a transaction note, on any record', () => {
    /* THREE DELIBERATE ZEROES, AND THEY ARE THE RESULT, NOT A SHORTFALL.
     *
     * 84% of this corpus's acquisition blocks carry a payee and every one
     * of them reads like a dealer, so a rule that copied the payee across
     * would show 380-odd filled fields here and look like an improvement.
     * It would be filling the owner's real export with his own account
     * names. See the note in quicken-import.service.ts. */
    expect(CORPUS['purchasedFrom']).toBe(0);
    expect(CORPUS['soldTo']).toBe(0);
    expect(CORPUS['transactionNotes']).toBe(0);
  });
});

/*
 * quicken-authenticity.spec.ts — FAKES IMPORT, AND THE WORD SURVIVES.
 *
 * TWO RULES, AND THEY PULL IN OPPOSITE DIRECTIONS, WHICH IS WHY THEY ARE
 * PINNED TOGETHER IN ONE FILE.
 *
 *   1. A counterfeit the owner keeps is a thing he owns, so it IMPORTS. It
 *      is not refused, not filtered, not quietly downgraded.
 *   2. The word that says it is a counterfeit has to SURVIVE the import, in
 *      the Variety field. Before this, "1855 3CS - VF - FAKE" imported as an
 *      1855 three-cent silver in VF with Variety empty: byte for byte the
 *      same record as the genuine one, and the owner had no way to tell them
 *      apart in the grid. Five records in the QIF corpus were in that state.
 *
 * AND ONE RULE THAT IS NOT ABOUT FAKES AT ALL, ASSERTED HERE BECAUSE THIS IS
 * WHERE IT WOULD BE BROKEN: Notes is the Quicken memo (`M`) column and
 * nothing else. The obvious wrong way to implement rule 2 is to write a
 * sentence about the coin into Notes, and the obvious wrong way to make an
 * import "more helpful" is to fall back to the security name when there is
 * no memo. Both are tested against here.
 *
 * *** DO NOT CONFUSE ANY OF THIS WITH THE IMAGE MATCHER. ***
 * filename-vocabulary.ts keeps counterfeit PHOTOGRAPHS out of the automated
 * matching run, and that exclusion is matcher-only by standing policy -- such
 * a photo stays listable, searchable and attachable by hand. It is a
 * different mechanism answering a different question, and nothing in it is a
 * reason to refuse an import. The three single words are shared with it so
 * that "what counts as the word fake" has one definition; the behaviour is
 * not shared at all.
 */


const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../testing/qif-corpus');
const CORPUS_FILES = readdirSync(CORPUS_DIR).filter(name => name.toUpperCase().endsWith('.QIF'));

/** A one-line QIF holding a single purchase of `security`. */
function buy(security: string, extraLines: string[] = []): string {
  return ['!Type:Invst', 'D01/15/2024', 'NBuy', `Y${security}`, 'T25.00', ...extraLines, '^', '']
    .join('\n');
}

function importOne(security: string, extraLines: string[] = []) {
  const result = new QuickenImportService().parse(buy(security, extraLines));
  expect(result.importedRecords, `"${security}" did not import`).toHaveLength(1);
  return result.importedRecords[0];
}

describe('a counterfeit in the Quicken file', () => {
  it('imports, rather than being refused or filtered out', () => {
    const result = new QuickenImportService().parse(buy('1855 3CS - VF - FAKE'));

    expect(result.importedRecords).toHaveLength(1);
    expect(result.rejectedRecords).toEqual([]);
    expect(result.skippedRecords).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('carries the word into Variety, spelled the way the owner wrote it', () => {
    // Verbatim, not normalised to a house spelling. Variety is a field he
    // reads; rewriting his own word in it is a change nobody asked for.
    expect(importOne('1855 3CS - VF - FAKE').variety).toBe('FAKE');
    expect(importOne('1860 Counterfeit 3CS - VF').variety).toBe('Counterfeit');
    expect(importOne('1921 $1 Morgan replica - AU').variety).toBe('replica');
  });

  it('reads "not genuine" as well, which is a phrase and not a word', () => {
    expect(importOne('1916 25¢ - VF - not genuine').variety).toBe('not genuine');
    expect(importOne('1916 25¢ - VF - NOT  GENUINE').variety).toBe('NOT  GENUINE');
  });

  it('keeps the variety it already had instead of replacing it', () => {
    /* A doubled die that is also a fake is both facts at once. The two
     * readings are independent, so one must not consume the other. */
    const record = importOne('1861 3CS DDO - XF - FAKE');

    expect(record.variety).toContain('DDO');
    expect(record.variety).toContain('FAKE');
  });

  it('leaves an ordinary coin\'s Variety exactly as it was', () => {
    expect(importOne('1921 Morgan Dollar MS63').variety).toBe('');
    expect(importOne('1883 5¢ Shield Type I - PF66').variety).toBe('Type I');
  });

  it('does not treat "copy" as a counterfeit marker', () => {
    /* Deliberately absent from the shared word list -- it is also what
     * Windows appends to a duplicated file, and in a Quicken security name
     * it is far likelier to be prose. See COUNTERFEIT_MARKER_WORDS. */
    expect(importOne('1909 1¢ VDB copy dies - VF').variety).toBe('');
  });

  it('does not match the word inside a longer one', () => {
    // Whole-token, like every other reading in this parser.
    expect(importOne('1878 50¢ Fakenham Hoard - VF').variety).toBe('');
  });

  it('writes NOTHING about it into Notes', () => {
    /* The wording is a description of the coin and belongs in Variety.
     * Notes is the Quicken memo column; see the suite below. */
    const record = importOne('1855 3CS - VF - FAKE');

    expect(record.notes).toBe('');
  });
});

describe('the counterfeits in the real QIF corpus', () => {
  /** Every record the corpus produces, across every file, with its name. */
  const records = CORPUS_FILES.flatMap(file => {
    const result = new QuickenImportService().parse(decodeQif(file));
    return result.importedRecords.map(record => ({ file, record }));
  });

  const fakes = records.filter(
    ({ record }) => /\b(?:fake|counterfeit|replica)\b/i.test(record.securityName ?? '')
  );

  it('finds the counterfeits the collection actually holds', () => {
    /* Measured, not assumed. Three distinct securities across two accounts,
     * two of which appear in both files -- five records in total. If the
     * corpus is regenerated this number moves; what must not move is that
     * it is greater than zero, or the assertions below pass vacuously. */
    expect(fakes.length, 'the corpus no longer contains a counterfeit').toBeGreaterThan(0);
    expect(fakes).toHaveLength(5);
  });

  it('imports every one of them', () => {
    // They are in `importedRecords` by construction above, so this is really
    // a statement about the count: none of the five went missing.
    expect(fakes.map(({ record }) => record.securityName).sort()).toEqual([
      '1855 3CS - VF - FAKE',
      '1855 3CS - VF - FAKE',
      '1859 3CS - XF - FAKE',
      '1859 3CS - XF40 - FAKE',
      '1859 3CS - XF40 - FAKE'
    ]);
  });

  it('gives every one of them a Variety saying so', () => {
    /* THE REGRESSION THIS EXISTS FOR. All five used to import with Variety
     * empty, indistinguishable in the grid from the genuine 1855 and 1859
     * three-cent silvers sitting next to them -- and this collection holds
     * several of each, which is exactly where the confusion lands. */
    for (const { file, record } of fakes) {
      expect(record.variety, `${file}: "${record.securityName}" lost its wording`)
        .toBe('FAKE');
    }
  });
});

describe('Notes is the Quicken memo column and nothing else', () => {
  it('is exactly the `M` line when there is one', () => {
    expect(importOne('1921 Morgan Dollar MS63', ['MBought at the Baltimore show']).notes)
      .toBe('Bought at the Baltimore show');
  });

  it('is BLANK when there is no `M` line, however much else is on the row', () => {
    /* NO FALLBACK. The security name, the payee, the account, the action
     * and the date are all in hand at the point Notes is written, and any
     * of them could be made to read like a note. None of them is the
     * owner's note, and a field he did not write is a field he cannot
     * trust. */
    const record = importOne('1909-S VDB 1¢ - PCGS/CAC AU58', ['PKingsmere Numismatics']);

    expect(record.notes).toBe('');
  });

  it('does not fall back to the memo of a DIFFERENT coin', () => {
    const qif =
      ['!Type:Invst', 'D01/15/2024', 'NBuy', 'Y1921 Morgan Dollar MS63', 'T50.00',
       'MThis note belongs to the Morgan', '^',
       'D01/16/2024', 'NBuy', 'Y1964 Quarter', 'T5.00', '^', ''].join('\n');

    const byName = new Map(
      new QuickenImportService().parse(qif).importedRecords.map(r => [r.securityName, r.notes])
    );

    expect(byName.get('1921 Morgan Dollar MS63')).toBe('This note belongs to the Morgan');
    expect(byName.get('1964 Quarter')).toBe('');
  });

  it('is left blank rather than synthesised across the whole corpus', () => {
    /* MEASURED OVER THE REAL EXPORTS, TWICE.
     *
     * BEFORE the transfer-memo rule: 66 of the 457 records the corpus
     * imports carried a note, and every single one of them was Quicken's
     * own `Xfr From: Misc. Coins` -- auto-generated text the owner never
     * typed. Not most of them. All 66.
     *
     * AFTER: 0. There is no coin in this corpus whose memo the owner wrote
     * himself, so the honest Notes column for it is empty, and that is what
     * he asked for: "If there's a note/memo field from the QIF then use it,
     * otherwise leave Notes as blank."
     *
     * The count is pinned at exactly 0 rather than "fewer than 66" so that
     * a broader filter -- one that started eating real memos -- and a
     * weaker one -- one that let the boilerplate back through -- both show
     * up here. The verbatim-memo rule itself is tested on hand-built QIFs
     * above and below, where a genuine memo can be put in deliberately. */
    const imported = CORPUS_FILES.flatMap(
      file => new QuickenImportService().parse(decodeQif(file)).importedRecords
    );
    const withNotes = imported.filter(record => (record.notes ?? '').trim() !== '');

    expect(imported.length).toBeGreaterThan(400);
    expect(withNotes.map(record => record.notes)).toEqual([]);
  });

  it('never lets the transfer boilerplate through, by any route', () => {
    /* The assertion that does not depend on the corpus's exact shape: no
     * matter how many notes survive, none of them may be the generated
     * line. Regenerate the corpus with ten real memos in it and this test
     * still says the right thing. */
    const imported = CORPUS_FILES.flatMap(
      file => new QuickenImportService().parse(decodeQif(file)).importedRecords
    );

    const boilerplate = imported
      .map(record => record.notes)
      .filter(notes => /^\s*xfr\s+(?:from|to)\s*:/i.test(notes ?? ''));

    expect(boilerplate).toEqual([]);
  });
});

/*
 * QUICKEN'S TRANSFER BOILERPLATE
 *
 * The owner: "Do not put in that 'Xfr From....' note. It's not really
 * helpful. If there's a note/memo field from the QIF then use it, otherwise
 * leave Notes as blank."
 *
 * The danger in implementing that is OVERREACH -- a filter that reads the
 * memo's SUBJECT rather than its SHAPE and eats a note the owner wrote
 * about a transfer. Half of the tests below are there to pin that down.
 */
describe('the Quicken transfer memo', () => {
  it('does not reach Notes from the receiving side', () => {
    expect(importOne('1862 3CS - NGC/CAC PF65', ['MXfr From: Misc. Coins']).notes).toBe('');
  });

  it('does not reach Notes from the sending side either', () => {
    expect(importOne('1884 3CN - PCGS PF66', ['MXfr To: Odd Type Set']).notes).toBe('');
  });

  it('is recognised whatever the spacing and case', () => {
    expect(importOne('1864 2¢', ['M  xfr  from :  Misc. Coins']).notes).toBe('');
    expect(importOne('1864 2¢', ['MXFR TO: Odd Type Set']).notes).toBe('');
  });

  it('leaves Notes BLANK rather than falling back to anything else', () => {
    // No synthesis: not the security name, not the payee, not the account.
    const record = importOne('1905 $20 - PCGS MS64', [
      'MXfr From: Misc. Coins',
      'PKingsmere Numismatics'
    ]);
    expect(record.notes).toBe('');
  });

  /* ---- AND NOW THE MEMOS THAT MUST SURVIVE ---- */

  it('does not eat a real memo that happens to mention a transfer', () => {
    // The corpus's own wording, on a cash block. A coin block could carry
    // it just as easily, and then it is the owner's note.
    expect(importOne('1921 Morgan Dollar MS63', ['MOpening transfer']).notes)
      .toBe('Opening transfer');
  });

  it('does not eat a memo that starts with the word transfer', () => {
    expect(importOne('1921 Morgan Dollar MS63', ['MTransferred from the bank box']).notes)
      .toBe('Transferred from the bank box');
  });

  it('does not eat a memo that starts with the word Xfr itself', () => {
    // "Xfr" with no "From:"/"To:" after it is not the generated line.
    expect(importOne('1921 Morgan Dollar MS63', ['MXfr paperwork mislaid']).notes)
      .toBe('Xfr paperwork mislaid');
  });

  it('does not eat a memo that mentions a transfer part-way through', () => {
    expect(importOne('1921 Morgan Dollar MS63', ['MSold to pay for the xfr to NGC']).notes)
      .toBe('Sold to pay for the xfr to NGC');
  });
});
