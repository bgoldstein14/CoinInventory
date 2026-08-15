import { describe, expect, it } from 'vitest';
import { QuickenImportService } from './quicken-import.service';

describe('QuickenImportService', () => {
  it('parses a QIF-style coin import into normalized records', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-01-15
NUS Half Dime
T12.50
MUS 1/2 Dime
YCoin Collection
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords.length).toBe(1);
    expect(result.importedRecords[0].denomination).toBe('Half Dime');
    expect(result.importedRecords[0].purchasePrice).toBe(12.5);
    expect(result.importedRecords[0].currentValue).toBe(12.5);
    expect(result.importedRecords[0].name).toContain('Half Dime');
  });

  it('records a warning and skips a block with no coin name', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-01-15
T50.00
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(0);
    expect(result.warnings[0]).toContain('without a name');
  });

  it('parses multiple Quicken blocks into separate imported coin records', () => {
    const service = new QuickenImportService();
    const qif = `!Type:Invst
D2024-01-15
NUS Half Dime
T12.50
MUS 1/2 Dime
YCoin Collection
^
D2024-02-20
NQuarter
T30.00
MUS Quarter
YCoin Collection
^
`;

    const result = service.parse(qif);

    expect(result.importedRecords).toHaveLength(2);
    expect(result.importedRecords[0].denomination).toBe('Half Dime');
    expect(result.importedRecords[1].denomination).toBe('Quarter');
  });

  it('allows importing only the selected Quicken account when multiple accounts are present', () => {
    const service = new QuickenImportService();
    const qif = `!Account
NChecking
^
!Type:Invst
D2024-01-15
NUS Half Dime
T12.50
MUS 1/2 Dime
YCoin Collection
^
!Account
NSavings
^
!Type:Invst
D2024-02-20
NQuarter
T30.00
MUS Quarter
YCoin Collection
^
`;

    const result = service.parse(qif, 'Checking');

    expect(result.accounts).toEqual(expect.arrayContaining(['Checking', 'Savings']));
    expect(result.importedRecords).toHaveLength(1);
    expect(result.importedRecords[0].name).toContain('Half Dime');
  });
});
