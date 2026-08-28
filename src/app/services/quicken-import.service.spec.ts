import { describe, expect, it } from 'vitest';
import { QuickenImportService } from './quicken-import.service';

describe('QuickenImportService', () => {
  it('parses a QIF investment transaction into a normalized record', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NAdd
YUS Half Dime FS-101
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
    expect(result.importedRecords[0].year).toBe(''); // No year in security name
    expect(result.importedRecords[0].coinType).toBe(''); // Blank by default
  });

  it('records a warning and skips a block with no security name', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-01-15
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.warnings[0]).toContain('no security name');
  });

  it('parses multiple transactions into separate imported records', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NAdd
YUS Half Dime
T12.50
^
D02/20/2024
NAdd
YQuarter
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
YUS Half Dime
T12.50
^
!Account
NSavings
^
!Type:Invst
D02/20/2024
NAdd
YQuarter
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

    // Field renamed from 'type' to 'coinType' in overhaul
    expect(result.importedRecords[0].coinType).toBe('');
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

    // Coin was bought then sold - net quantity is 0, should be skipped
    expect(result.importedRecords).toHaveLength(0);
    expect(result.skippedRecords).toHaveLength(1);
    expect(result.skippedRecords[0].denomination).toBe('25¢');
    expect(result.warnings.some(w => w.includes('net quantity is 0'))).toBe(true);
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

  it('parses 3CS as 3¢ Silver with year and grade (1861 3CS - AU)', () => {
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
    expect(coin.denomination).toBe('3¢ Silver');
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
    const qif = `!Type:Invst
D01/15/2024
NBuy
Y1890 Random Token
T10.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(1);
    const coin = result.importedRecords[0];
    expect(coin.pmWeightGrams).toBeUndefined();
    expect(coin.pmPercent).toBeUndefined();
  });
});
