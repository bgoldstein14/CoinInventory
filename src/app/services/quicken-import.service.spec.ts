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
    expect(result.importedRecords[0].name).toBe('US Half Dime FS-101');
    expect(result.importedRecords[0].denomination).toBe('Half Dime');
    expect(result.importedRecords[0].purchasePrice).toBe(12.5);
    expect(result.importedRecords[0].currentValue).toBe(12.5);
    expect(result.importedRecords[0].purchaseDate).toBe('2024-01-15');
    expect(result.importedRecords[0].notes).toBe('Original owner note');
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
    expect(result.importedRecords[0].denomination).toBe('Half Dime');
    expect(result.importedRecords[1].denomination).toBe('Quarter');
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
    expect(result.importedRecords[0].name).toBe('US Half Dime');
  });

  it('skips a disposed (sold) holding and records why', () => {
    const service = new QuickenImportService();
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
    expect(result.warnings[0]).toContain('Sell');
    expect(result.warnings[0]).toContain('Mercury Dime 1945-S');
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

  it('sets type to empty string rather than the QIF action code', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D01/15/2024
NBuyX
YLiberty Head Double Eagle
T2450.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords[0].type).toBe('');
  });
});
