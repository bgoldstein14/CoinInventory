import { describe, expect, it } from 'vitest';
import {
  QuickenImportService,
  checkMainCoinDetails,
  isCoinDetailPresent
} from './quicken-import.service';

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

  it('silently skips fully disposed coins without surfacing warnings', () => {
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

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.warnings.some(w => w.includes('fully disposed') || w.includes('net quantity is'))).toBe(false);
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

    const result = service.parse(qif);

    // Coin was bought then sold - net quantity is 0, should be skipped silently
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

  // -------------------------------------------------------------------
  // The 2-of-3 main-detail rule (Year / Coin Type / Denomination).
  //
  // Background: a coin described by a year alone used to be imported and
  // then rejected by the backend with `400 {"error":"denomination is
  // required"}`. The old guard only rejected coins missing BOTH year and
  // denomination, and ignored coin type entirely.
  // -------------------------------------------------------------------

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
    // The exact case the user reported: a row carrying nothing but a year.
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

    const result = service.parse(qif);

    // Held and fully detailed -> imported
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].coinType).toBe('Morgan');

    // Held but under-detailed -> exception (visible, not silently dropped)
    expect(result.rejectedRecords).toHaveLength(1);
    expect(result.rejectedRecords[0].securityName).toBe('1943 Steel');

    // Bought then sold -> net quantity filtering still applies
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.skippedRecords[0].denomination).toBe('25¢');
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

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.rejectedRecords).toHaveLength(0);
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
});
