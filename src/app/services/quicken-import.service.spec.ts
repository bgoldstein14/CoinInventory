/*
 * Tests for the QIF import, including the sections for sold dates, the payee
 * (never used as a dealer) and authenticity wording.
 * quicken-corpus-securities.spec.ts is separate.
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
    // "Half Dime" becomes symbolic "5¢".
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

    // `excludeSold` is the "only coins I still own" option, off by default (see below).
    const result = service.parse(qif, undefined, undefined, { excludeSold: true });

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.warnings.some(w => w.includes('fully disposed') || w.includes('net quantity is'))).toBe(false);
  });

  it('imports a fully disposed coin BY DEFAULT, and says it is sold', () => {
    /* By default sold coins import too: cost, grade and sale are still reportable. */
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
    // Nothing is held out.
    expect(result.skippedRecords).toHaveLength(0);
    // ...but the caller is told which coins are gone, to mark them Sold.
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
    // A standalone Sell (no prior Buy) leaves nothing to skip or warn about.
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
    // No warning for standalone sells.
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

    // Coin type from an explicit name in the security string.
    expect(result.importedRecords[0].coinType).toBe('Liberty Head');
  });

  // Net-quantity filtering

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

    // Bought then sold (net 0), and only held coins were requested.
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

    // Bought and never sold (net 1): imported.
    expect(result.importedRecords).toHaveLength(1);
    expect(result.skippedRecords).toHaveLength(0);
    expect(result.importedRecords[0].denomination).toBe('25¢');
  });

  // Attribute parsing

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
    // "Dollar" becomes symbolic "$1".
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
    // Reported as an exception, not dropped.
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

  // PM pre-fill

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
    // 1960 quarter: 90% silver, 5.63 g PM weight.
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
    // 1964 dime: 90% silver, 2.25 g PM weight.
    expect(coin.pmWeightGrams).toBeCloseTo(2.25, 2);
    expect(coin.pmPercent).toBe(90);
  });

  it('does not pre-fill pmWeightGrams for unknown coins', () => {
    const service = new QuickenImportService();
    // A copper cent imports, but there is no precious metal to pre-fill.
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

  // Odd Type denomination and coin type enrichment

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

  // The 2-of-3 rule (Year / Coin Type / Denomination). Without it a year-only
  // coin would be rejected by the backend (`400 {"error":"denomination is required"}`).

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
    // No year, but Coin Type (Morgan) and Denomination ($1): 2 of 3.
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
    // A row with nothing but a year.
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
    // The partly parsed record is kept for review / override.
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

    // Held and fully detailed: imported.
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].coinType).toBe('Morgan');

    // Held but under-detailed: exception.
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0].securityName).toBe('1943 Steel');

    // Bought then sold, and only held coins were requested.
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.skippedRecords[0].denomination).toBe('25¢');
  });

  it('separates imported and excepted coins with the sold ones left in', () => {
    /* Same file with the option off (default): the sold quarter imports and is
     * named as sold; the under-detailed row is still an exception. */
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
    /* With the sold filter off, the 2-of-3 rule judges every row: "1943 Steel" has
     * only a year, so it lands in the exceptions panel. */
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
    * Certification company and CAC sticker, using names from a real Quicken
    * export. Protected: whole-token matching ("NGC" never as a fragment), and
    * CAC (a sticker on another slab) vs CACG (CAC's grading service).
    */
  describe('certification company and CAC sticker', () => {
    /** Wraps a security name in a minimal QIF transaction and returns the parsed record. */
    function parseSecurityName(securityName: string) {
      const service = new QuickenImportService();
      const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`;
      const result = service.parse(qif);
      // Every fixture has 2+ main details, so it is imported.
      expect(result.importedRecords).toHaveLength(1);
      return result.importedRecords[0];
    }

    // Every company token. PCGS / NGC / ANACS / ICG occur in the export; SEGS /
    // CACG / NNC are also supported.
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
      // Names are hand-typed; the stored value is the canonical upper-case token.
      expect(parseSecurityName('1927 $20 - pcgs MS64').certCompany).toBe('PCGS');
    });

    it('matches a company token separated by a hyphen or a slash, not just a space', () => {
      // Both appear verbatim in the real export.
      expect(parseSecurityName('1908 $20-PCGS MS63').certCompany).toBe('PCGS');
      expect(parseSecurityName('1838 Reeded 50¢-XF (CLEANED/PCGS)').certCompany).toBe('PCGS');
    });

    it('does not match NGC inside a longer word', () => {
      // A substring search would find "NGC" inside "RINGCASE".
      const coin = parseSecurityName('1921 Morgan Dollar RINGCASE MS63');
      expect(coin.certCompany).toBe('');
    });

    it('leaves certCompany empty and hasCacSticker false when the name names neither', () => {
      const coin = parseSecurityName('1921 Morgan Dollar MS63');
      expect(coin.certCompany).toBe('');
      // False, never undefined: the column is BIT NOT NULL.
      expect(coin.hasCacSticker).toBe(false);
      expect(coin.hasCacSticker).not.toBeUndefined();
    });

    // The grade usually follows the company and must survive it.
    it('does not corrupt a grade that sits right after the company', () => {
      expect(parseSecurityName('1927 $20 - PCGS MS64').grade).toBe('MS64');
      expect(parseSecurityName('1875 20¢ - ANACS VG8').grade).toBe('VG8');
      expect(parseSecurityName('1876 20¢ - PCGS/CAC XF45').grade).toBe('XF45');
      // The designation is captured and the separator removed.
      expect(parseSecurityName('1982 Israel 5 Shilling - ANACS PF69 DCAM').grade).toBe('PF69DCAM');
    });

    // Grade designations: a `\b`-terminated pattern fails on "PF65RB" (no word
    // boundary between "5" and "R").
    it('captures numeric grades that carry a designation suffix', () => {
      const cases: [string, string][] = [
        ['1870 1¢ - NGC PF65RB', 'PF65RB'],            // red-brown
        ['1867 3CS - NGC PF64Cameo', 'PF64CAMEO'],     // cameo, no separator
        ['1867 3CS - NGC PF64 Cameo', 'PF64CAMEO'],    // cameo, spaced
        ['1884 3CN - PCGS PF65CAM', 'PF65CAM'],
        // "Israel" alone isn't a denomination, so the unit is spelled out to pass the
        // 2-of-3 rule.
        ['1982 Israel 5 Shilling - ANACS PF69DCAM', 'PF69DCAM'],  // deep cameo
        ['1886 $1 - ICG MS64DMPL', 'MS64DMPL'],        // deep mirror prooflike
        ['1938 5¢ - PCGS MS70-FS', 'MS70FS'],          // full steps
      ];
      for (const [name, expected] of cases) {
        expect(parseSecurityName(name).grade, name).toBe(expected);
      }
    });

    it('keeps the plus modifier on a grade', () => {
      // "+" isn't a word character, so a `\b`-terminated pattern would drop it.
      expect(parseSecurityName('1870 $1 - PCGS/CAC PF62+').grade).toBe('PF62+');
      expect(parseSecurityName('1927 $20 - PCGS MS64+').grade).toBe('MS64+');
    });

    it('still parses plain grades exactly as before', () => {
      // The fallback pass keeps plain grades working.
      expect(parseSecurityName('1906-S $5 - XF').grade).toBe('XF');
      expect(parseSecurityName('1871 3CN - AU53').grade).toBe('AU53');
      expect(parseSecurityName('1875 20¢ - VG8').grade).toBe('VG8');
      expect(parseSecurityName('1852 3CS - CH+AU').grade).toBe('CH+AU');
      expect(parseSecurityName('1873 3CN - VF/EF').grade).toBe('VF/EF');
    });

    it('does not invent a designation from surrounding words', () => {
      // Trailing text like "(CLEANED)" must not be absorbed or block the grade.
      expect(parseSecurityName('1852 3CS ANACS AU53 (CLEANED)').grade).toBe('AU53');
      expect(parseSecurityName('1838 Reeded 50¢-XF (CLEANED/PCGS)').grade).toBe('XF');
    });

    it('extracts exactly the same grade with or without a company token present', () => {
      // Adding the company in front must not change the grade parsed (some of these
      // grades aren't recognised at all; company detection must neither help nor hurt).
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

    // CAC sticker: "PCGS/CAC" and "NGC/CAC" are the most common forms.
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

    it('sets no CAC sticker when the name gives no grade', () => {
      expect(parseSecurityName('1875 20¢ - PCGS/CAC').hasCacSticker).toBe(false);
    });

    it('still reads the grading company when a CAC sticker is also present', () => {
      // "PCGS/CAC": PCGS slab and CAC sticker.
      const coin = parseSecurityName('1909 S-VDB 1¢ - PCGS/CAC AU58');
      expect(coin.certCompany).toBe('PCGS');
      expect(coin.hasCacSticker).toBe(true);
      expect(coin.grade).toBe('AU58');
    });

    it('treats CACG as the grading company and NOT as a CAC sticker', () => {
      // CACG is CAC's grading service, not a sticker.
      const coin = parseSecurityName('1875 20¢ - CACG MS65');
      expect(coin.certCompany).toBe('CACG');
      expect(coin.hasCacSticker).toBe(false);
    });

    it('sets both fields when a CACG coin also carries a CAC sticker', () => {
      // An explicit CAC token still registers next to CACG.
      const coin = parseSecurityName('1875 20¢ - CACG MS65 (CAC)');
      expect(coin.certCompany).toBe('CACG');
      expect(coin.hasCacSticker).toBe(true);
    });

    it('does not mistake Quicken\'s "W/C" (with cents) shorthand for a CAC sticker', () => {
      // "W/C" here means "with CENTS" (the 1883 Liberty nickel), not CAC.
      const coin = parseSecurityName('1883 5¢ W/C-NGC PF65');
      expect(coin.hasCacSticker).toBe(false);
      expect(coin.certCompany).toBe('NGC');
    });

    it('does not let a slab label alone satisfy the 2-of-3 main-detail rule', () => {
      // Cert company and CAC aren't main details: a slab-only row is still an exception.
      const service = new QuickenImportService();
      const qif = `!Type:Invst\nD01/15/2024\nNBuy\nY1943 PCGS/CAC MS65\nT100.00\n^\n`;

      const result = service.parse(qif);

      expect(result.importedRecords).toHaveLength(0);
      expect(result.rejectedRecords).toHaveLength(1);
      expect(result.rejectedRecords[0].missing).toContain('Denomination');
      // The fields are parsed but don't count toward the rule.
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

  /*
   * Denominations not written as a face value, from real QIF securities.
   * Silver Eagle is $1; Eagle $10, Double Eagle $20, Half Eagle $5, Quarter
   * Eagle $2.50; the modern Gold Eagle (since 1986) is $50. One table; add a row
   * for a new case.
   */
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
      // Silver, asked about before the bare "Eagle" test
      ['1987 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2006 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2008 Proof Silver Eagle', '$1', 'was imported as a $10 gold piece'],
      ['2025 250th Anniversary U.S. Army ASE', '$1', 'ASE is the American Silver Eagle'],

      // Classic gold eagles
      ['1907 Double Eagle - PCGS MS63', '$20', 'double eagle still wins over eagle'],
      ['1901S Eagle - NGC AU58', '$10', 'a bare gold Eagle is still ten dollars'],

      // Modern one-ounce gold, settled by year
      ['1986S Au $50-PF', '$50', 'explicit $50 face value, previously unreadable'],
      ['2025 $50 Gold Buffalo - NGC MS70 FR', '$50', 'explicit $50 face value'],

      // Initialisms used with no other denomination word
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

    /* "1987 2-coin Proof American Gold Eagle Set" is a $50 and a $25, so no
     * denomination is assigned and the row goes to the exceptions list. */
    it('refuses to pick a denomination for a multi-coin Gold Eagle set', () => {
      const record = parseOne('1987 2-coin Proof American Gold Eagle Set (1.5 troy oz.)');
      expect(record.denomination).toBe('');
    });

    /* The denomination is read; the metal is not (the name doesn't say gold and
     * no reference row covers an Israeli commemorative). */
    it('reads Israeli sheqalim written as a bare S', () => {
      expect(parseOne('1982 Israel Qumran 5S - ANACS PF69DCAM').denomination)
        .toBe('5 Sheqalim');
    });

    it('will not read a bare S as sheqalim when the name does not say Israel', () => {
      // "5S" on an American coin is mint-mark shaped; the Israel guard prevents
      // reading it as sheqalim.
      expect(parseOne('1885 5S Morgan Dollar - PCGS MS63').denomination).toBe('$1');
    });
  });

  /*
   * Ambiguous readings via `AmbiguousReading` (coin.model.ts); the three-cent
   * piece is currently the only case.
   *   1. Certain bands answer without a flag: 1851-1864 silver, 1874-1889 nickel.
   *   2. The 1865-1873 overlap still answers (the row imports) but is flagged.
   *   3. In the overlap, proof means silver, anything else nickel.
   *   4. A name spelling out 3CS or 3CN is never flagged.
   *   5. The user's answer moves the denomination and everything derived from it.
   */
  describe('ambiguous readings are answered, flagged and correctable', () => {
    /** Parses one security name, whether it imports or is excepted. */
    const parseOne = (securityName: string) => {
      const service = new QuickenImportService();
      const result = service.parse(
        `!Type:Invst\nD01/15/2024\nNBuy\nY${securityName}\nT100.00\n^\n`
      );
      return [...result.importedRecords, ...result.rejectedRecords.map(r => r.record)][0];
    };

    /** The denomination flag on a record, or undefined when certain. */
    const flagOf = (securityName: string) =>
      parseOne(securityName).ambiguities?.find(a => a.field === 'denomination');

    interface ThreeCentCase {
      /** The security name, written as a bare reading. */
      name: string;
      /** What the importer should settle on. */
      denomination: string;
      /** True when the answer is a guess and must be flagged. */
      flagged: boolean;
      /** Why this row is in the table. */
      why: string;
    }

    const cases: ThreeCentCase[] = [
      // Certain: before the nickel existed
      { name: '1851 3¢ - EF', denomination: '3CS', flagged: false,
        why: 'first year of the silver; the nickel is fourteen years away' },
      { name: '1862 3¢ - XF45', denomination: '3CS', flagged: false,
        why: 'still silver-only, so the scarcity rule never has to be consulted' },
      { name: '1864 3¢ - PCGS PF64', denomination: '3CS', flagged: false,
        why: 'last silver-only year -- certain even though it is a proof' },

      // The overlap: a guess, flagged
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

      // Certain: after the silver ended
      { name: '1874 3¢ - AU', denomination: '3CN', flagged: false,
        why: 'first nickel-only year' },
      { name: '1889 3¢ - NGC PF65 Cameo', denomination: '3CN', flagged: false,
        why: 'last year of the nickel; a proof proves nothing here, the date settles it' },

      // Not ambiguous: the name says which
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
      // A guess still imports; it is never an exception.
      expect(result.importedRecords).toHaveLength(1);
      expect(result.rejectedRecords).toHaveLength(0);
      expect(result.importedRecords[0].ambiguities).toHaveLength(1);
    });

    it('carries both candidates and a readable reason on the flag', () => {
      const flag = flagOf('1870 3¢ - AU');
      expect(flag).toBeDefined();
      expect(flag!.chosen).toBe('3CN');
      // Both members, so the preview can offer the other one.
      expect([...flag!.alternatives].sort()).toEqual(['3CN', '3CS']);
      // The user-facing reason names the overlap and the assumption.
      expect(flag!.why).toContain('1865-1873');
      expect(flag!.why).toMatch(/scarce/i);
    });

    it('explains the proof exception when it is the proof branch that fired', () => {
      const flag = flagOf('1868 3¢ - PCGS PR65');
      expect(flag!.chosen).toBe('3CS');
      expect(flag!.why).toMatch(/proof/i);
    });

    it('treats a three-cent name with no year as maximally ambiguous', () => {
      // No year: the whole 1851-1889 span, same tie-break and flag. (Every
      // three-cent name in the corpus spells out 3CS or 3CN.)
      const record = parseOne('3¢ - VF');
      expect(record.denomination).toBe('3CN');
      const flag = record.ambiguities?.find(a => a.field === 'denomination');
      expect(flag).toBeDefined();
      expect(flag!.why).toContain('1851-1889');
    });

    it('leaves every unambiguous coin with no flag at all', () => {
      // Undefined, not [], on an ordinary record.
      expect(parseOne('1927 $20 - PCGS MS64').ambiguities).toBeUndefined();
      expect(parseOne('1921 Morgan Dollar MS63').ambiguities).toBeUndefined();
    });

    it('carries the raw security name so a preview row has a stable identity', () => {
      // `id` is a new UUID per parse, so the import modal keys answers on this.
      expect(parseOne('1870 3¢ - AU').securityName).toBe('1870 3¢ - AU');
    });

    /*
     * The user's answer must go back through the parser: coin type and the five
     * alloy/weight fields derive from the denomination (an 1870 three-cent silver
     * is 90% silver at 0.75 g; the nickel has no precious metal).
     */
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
      // Fields that would be wrong if the caller only overwrote `denomination`.
      expect(corrected.coinType).toBe('Three Cent Silver');
      expect(corrected.pmPercent).toBe(90);
      // The flag stays (it was ambiguous) and reports what is on the record.
      expect(corrected.ambiguities?.[0].chosen).toBe('3CS');
    });

    it('ignores a choice for a value the parser never offered', () => {
      const service = new QuickenImportService();
      const record = service.parse(overlapQif, undefined, { '1870 3¢ - AU': '$20' })
        .importedRecords[0];
      // Correcting a guess must not become free-text editing of the import.
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
 * Sold dates. A QIF has no "sold" column; net quantity detects a disposal, and
 * the disposal block's date and amount become Sold Date and Sold Price, so the
 * shared sold rule (import-sold.ts) applies to QIF imports as to CSV and Excel.
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
    /* 0 is a real sale price (given away). A ShrsOut transfer states no amount, so
     * no price is recorded. */
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

    // Two bought, one sold: net 1, still held; the sale belongs to the one that left.
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
    /* A disposal without a `D` line gives the shared rule nothing to read, but the
     * coin is still gone and must stay excluded. */
    const result = parseSold(
      qif(BUY('1864 2¢'), ['NShrsOut', 'Y1864 2¢', 'Q1']),
      true
    );

    expect(result.importedRecords).toEqual([]);
    expect(result.skippedRecords.map(r => r.securityName)).toEqual(['1864 2¢']);
  });
});

/*
 * The payee is never used as a dealer. The importer fills Purchase Date/Price
 * from the Buy block and Sold Date/Price from the disposal, and nothing for the
 * counterparty fields however dealer-like the `P` line looks. In a Quicken
 * investment register the payee is routinely the account name ("Misc. Coins").
 *
 * The test corpus invents dealer payees on 84% of acquisition blocks
 * (`DEALERS` in generate-corpus.mjs) and account names on none, so it can't
 * judge a payee rule; the census below measures only what the importer fills.
 */


/** Fields the importer must never fill, whatever the file says. */
const NEVER_FILLED = ['purchasedFrom', 'soldTo', 'transactionNotes'] as const;

function parsePayee(qif: string) {
  return new QuickenImportService().parse(qif);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('1. what a Buy block honestly carries, and does', () => {
  it('fills Purchase Date and Purchase Price from the block itself', () => {
    // `D` is the date and `T` the amount.
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
    // So the shared rule answers as it would for a spreadsheet row.
    expect(isSoldRecord(record as never)).toBe(true);
  });
});

describe('2. the payee, which is never a counterparty', () => {
  it('writes nothing for a payee that looks exactly like a dealer', () => {
    // A dealer-like payee is still not evidence: the same line holds account names
    // in real exports.
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
    // On a SellX the payee is normally the account the proceeds went to.
    const record = asRecord(parsePayee(
      '!Type:Invst\n' +
      'D03/14/2014\nNBuyX\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT158.33\nPHarbourstone Coins\n^\n' +
      'D07/06/2015\nNSellX\nY1881-S Morgan $1 - PCGS MS64\nQ1\nT242.26\nPTollgate Rarities\n^\n'
    ).importedRecords[0]);

    expect(record['soldTo']).toBeUndefined();
    expect(record['purchasedFrom']).toBeUndefined();
    // The disposal data that is in the file is still read.
    expect(record['soldDate']).toBe('2015-07-06');
    expect(record['soldPrice']).toBe(242.26);
  });

  it('does not let a payee alone make a coin look sold', () => {
    // A payee in `soldTo` would mark every coin sold, so "only coins I still own"
    // would import nothing.
    const record = asRecord(parsePayee(
      '!Type:Invst\nD03/14/2014\nNBuy\nY1881-S Morgan $1 - PCGS MS64\nQ1\n' +
      'T158.33\nPKingsmere Numismatics\n^\n'
    ).importedRecords[0]);

    expect(isSoldRecord(record as never)).toBe(false);
  });

  it('leaves the transaction note empty while the memo still reaches Notes', () => {
    // The QIF memo goes to Coins.Notes; nothing goes to TransactionNotes.
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
      // Text is present once trimmed; numbers are present at 0 (as in import-sold.ts).
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
    // Non-vacuity: if the fixture stops producing coins, every count goes to zero.
    expect(CORPUS['total']).toBe(457);
    expect(QIF_ACCOUNTS).toHaveLength(7);
  });

  it('fills both purchase fields on every single record', () => {
    // Every acquisition block has `D` and an amount.
    expect(CORPUS['purchaseDate']).toBe(457);
    expect(CORPUS['purchasePrice']).toBe(457);
  });

  it('fills the sale fields only where the file recorded a disposal', () => {
    // 352 sold dates but 285 sold prices: ShrsOut transfers have no amount, and
    // must not get a 0.
    expect(CORPUS['soldDate']).toBe(352);
    expect(CORPUS['soldPrice']).toBe(285);
  });

  it('fills NEITHER counterparty, nor a transaction note, on any record', () => {
    /* Three deliberate zeroes. A payee-copying rule would fill ~380 fields here and
     * look like an improvement, but would fill real exports with account names. */
    expect(CORPUS['purchasedFrom']).toBe(0);
    expect(CORPUS['soldTo']).toBe(0);
    expect(CORPUS['transactionNotes']).toBe(0);
  });
});

/*
 * Authenticity wording:
 *   1. A counterfeit the user owns imports like any other coin.
 *   2. The word ("FAKE") is kept in Variety, so the record differs from the
 *      genuine coin of the same date and grade.
 * Also: Notes is the Quicken memo only, with no synthesised text or fallback.
 *
 * Separate from the image matcher's exclusion of counterfeit photos
 * (filename-vocabulary.ts); only the word list is shared.
 */


const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../testing/qif-corpus');
const CORPUS_FILES = readdirSync(CORPUS_DIR).filter(name => name.toUpperCase().endsWith('.QIF'));

/** A QIF with a single purchase of `security`. */
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
    // Verbatim, not normalised.
    expect(importOne('1855 3CS - VF - FAKE').variety).toBe('FAKE');
    expect(importOne('1860 Counterfeit 3CS - VF').variety).toBe('Counterfeit');
    expect(importOne('1921 $1 Morgan replica - AU').variety).toBe('replica');
  });

  it('reads "not genuine" as well, which is a phrase and not a word', () => {
    expect(importOne('1916 25¢ - VF - not genuine').variety).toBe('not genuine');
    expect(importOne('1916 25¢ - VF - NOT  GENUINE').variety).toBe('NOT  GENUINE');
  });

  it('keeps the variety it already had instead of replacing it', () => {
    /* A doubled die that is also a fake: both readings are kept. */
    const record = importOne('1861 3CS DDO - XF - FAKE');

    expect(record.variety).toContain('DDO');
    expect(record.variety).toContain('FAKE');
  });

  it('leaves an ordinary coin\'s Variety exactly as it was', () => {
    expect(importOne('1921 Morgan Dollar MS63').variety).toBe('');
    expect(importOne('1883 5¢ Shield Type I - PF66').variety).toBe('Type I');
  });

  it('does not treat "copy" as a counterfeit marker', () => {
    /* "copy" is deliberately not in the word list (Windows appends it to duplicated
     * files; in a security name it is usually prose). See COUNTERFEIT_MARKER_WORDS. */
    expect(importOne('1909 1¢ VDB copy dies - VF').variety).toBe('');
  });

  it('does not match the word inside a longer one', () => {
    // Whole-token matching.
    expect(importOne('1878 50¢ Fakenham Hoard - VF').variety).toBe('');
  });

  it('writes NOTHING about it into Notes', () => {
    /* The wording describes the coin, so it goes in Variety, not Notes. */
    const record = importOne('1855 3CS - VF - FAKE');

    expect(record.notes).toBe('');
  });
});

describe('the counterfeits in the real QIF corpus', () => {
  /** Every record the corpus produces, across every file, with its file. */
  const records = CORPUS_FILES.flatMap(file => {
    const result = new QuickenImportService().parse(decodeQif(file));
    return result.importedRecords.map(record => ({ file, record }));
  });

  const fakes = records.filter(
    ({ record }) => /\b(?:fake|counterfeit|replica)\b/i.test(record.securityName ?? '')
  );

  it('finds the counterfeits the collection actually holds', () => {
    /* Three distinct securities across two accounts, five records. The number
     * moves if the corpus is regenerated; it must stay above zero. */
    expect(fakes.length, 'the corpus no longer contains a counterfeit').toBeGreaterThan(0);
    expect(fakes).toHaveLength(5);
  });

  it('imports every one of them', () => {
    // They are in `importedRecords` by construction, so this checks none went missing.
    expect(fakes.map(({ record }) => record.securityName).sort()).toEqual([
      '1855 3CS - VF - FAKE',
      '1855 3CS - VF - FAKE',
      '1859 3CS - XF - FAKE',
      '1859 3CS - XF40 - FAKE',
      '1859 3CS - XF40 - FAKE'
    ]);
  });

  it('gives every one of them a Variety saying so', () => {
    /* Each fake must carry its wording in Variety, distinguishing it from the
     * genuine three-cent silvers alongside. */
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
    /* No fallback: security name, payee, account, action and date are all
     * available but none is the user's note. */
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
    /* Over the corpus, every note came from Quicken's `Xfr From:` memo, so after
     * the rule none remain. Pinned at exactly 0 so both an over-broad filter and a
     * too-weak one show up. The verbatim-memo rule is tested on hand-built QIFs. */
    const imported = CORPUS_FILES.flatMap(
      file => new QuickenImportService().parse(decodeQif(file)).importedRecords
    );
    const withNotes = imported.filter(record => (record.notes ?? '').trim() !== '');

    expect(imported.length).toBeGreaterThan(400);
    expect(withNotes.map(record => record.notes)).toEqual([]);
  });

  it('never lets the transfer boilerplate through, by any route', () => {
    /* Independent of corpus shape: no surviving note may be the generated line. */
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
 * Quicken's `Xfr From:` / `Xfr To:` memo is dropped; other memos are kept as
 * written. Half of these tests guard against over-matching a memo that merely
 * mentions a transfer.
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
    // No synthesis: not the security name, payee or account.
    const record = importOne('1905 $20 - PCGS MS64', [
      'MXfr From: Misc. Coins',
      'PKingsmere Numismatics'
    ]);
    expect(record.notes).toBe('');
  });

  /* Memos that must survive */

  it('does not eat a real memo that happens to mention a transfer', () => {
    // The corpus's own wording; on a coin block it is the user's note.
    expect(importOne('1921 Morgan Dollar MS63', ['MOpening transfer']).notes)
      .toBe('Opening transfer');
  });

  it('does not eat a memo that starts with the word transfer', () => {
    expect(importOne('1921 Morgan Dollar MS63', ['MTransferred from the bank box']).notes)
      .toBe('Transferred from the bank box');
  });

  it('does not eat a memo that starts with the word Xfr itself', () => {
    // "Xfr" without "From:"/"To:" isn't the generated line.
    expect(importOne('1921 Morgan Dollar MS63', ['MXfr paperwork mislaid']).notes)
      .toBe('Xfr paperwork mislaid');
  });

  it('does not eat a memo that mentions a transfer part-way through', () => {
    expect(importOne('1921 Morgan Dollar MS63', ['MSold to pay for the xfr to NGC']).notes)
      .toBe('Sold to pay for the xfr to NGC');
  });
});
