/**
 * Tests that Export -> CSV produces a file the importer can fully read back:
 * export columns are derived from `CSV_MAPPABLE_FIELDS`, so every column must
 * auto-map, and values must survive the round trip.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { CSV_MAPPABLE_FIELDS, CsvService } from '../csv.service';
import { isSoldRecord } from '../import-sold';
import { BOM } from './byte-order-mark';

/**
 * CsvService constructed directly, with `downloadBlob` replaced by a capture
 * (it needs `document`), so tests assert on the real generated file content.
 */
function serviceCapturing(): {
  csv: CsvService;
  written: () => string;
  mimeType: () => string;
} {
  const csv = new CsvService();
  let content = '';
  let mimeType = '';
  (csv as unknown as Record<string, unknown>)['downloadBlob'] = vi.fn(
    (text: string, _filename: string, type: string) => { content = text; mimeType = type; }
  );
  return { csv, written: () => content, mimeType: () => mimeType };
}

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: 'S', composition: '90% Silver',
    purchaseDate: '2024-03-15', purchasePrice: 1250, currentValue: 1400,
    notes: '', imagePaths: [], source: 'quicken',
    ...overrides
  };
}

describe('Export -> CSV round trip', () => {
  it('every exported header auto-maps on re-import', () => {
    // Every exported column, including Source, must auto-map.
    const { csv } = serviceCapturing();
    const headers = csv.exportHeaderLabels();
    const mapping = csv.autoMapHeaders(headers);

    const unmapped = headers.filter(header => !mapping[header]);
    expect(unmapped).toEqual([]);
  });

  it('exports exactly the mappable fields, so the two lists cannot drift', () => {
    const { csv } = serviceCapturing();
    const mappableLabels = CSV_MAPPABLE_FIELDS
      .filter(field => field.key)
      .map(field => field.label);

    expect(csv.exportHeaderLabels()).toEqual(mappableLabels);
  });

  it('writes a header row followed by one row per coin', () => {
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin(), coin({ id: 'coin-2' })]);

    const lines = written().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Coin Type');
    expect(lines[0]).toContain('Source');
  });

  it('survives a full export then re-import with values intact', () => {
    const { csv, written } = serviceCapturing();
    // 26.73 is the Morgan dollar weight in grams.
    csv.exportCsv([coin({ notes: 'Toned, with a comma', weight: 26.73 })]);

    const rows = csv.parseCsv(written());
    const headers = rows[0];
    const mapping = csv.autoMapHeaders(headers);
    const reimported = csv.mapRowToCoin(rows[1], headers, mapping);

    expect(reimported.coinType).toBe('Morgan Dollar');
    expect(reimported.grade).toBe('MS63');
    expect(reimported.purchasePrice).toBe(1250);
    expect(reimported.weight).toBe(26.73);
    // A quoted field containing a comma must come back whole.
    expect(reimported.notes).toBe('Toned, with a comma');
  });
});

/**
 * The weight column is grams (server/migrations/008-weight-to-grams.sql). Old
 * exports headed `Weight (oz)` deliberately stay unmapped: mapping them would
 * import ounces as grams, and converting by header text would double-convert
 * sheets already in grams.
 */
describe('the weight column is grams, not troy ounces', () => {
  it('labels the exported column Weight (g)', () => {
    const { csv } = serviceCapturing();
    expect(csv.exportHeaderLabels()).toContain('Weight (g)');
    expect(csv.exportHeaderLabels()).not.toContain('Weight (oz)');
  });

  it('auto-maps the new Weight (g) header', () => {
    const { csv } = serviceCapturing();
    expect(csv.autoMapHeaders(['Weight (g)'])['Weight (g)']).toBe('weight');
  });

  it('does NOT auto-map the old Weight (oz) header, on purpose', () => {
    // A pre-008 `Weight (oz)` column must stay unmapped.
    const { csv } = serviceCapturing();
    expect(csv.autoMapHeaders(['Weight (oz)'])['Weight (oz)']).toBeUndefined();
  });

  it('leaves the rest of an old file importing normally', () => {
    // An unmapped weight column must not affect the rest of the row.
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Weight (oz)', 'Grade'];
    const mapping = csv.autoMapHeaders(headers);
    const imported = csv.mapRowToCoin(['Morgan Dollar', '0.7734', 'MS63'], headers, mapping);

    expect(imported.coinType).toBe('Morgan Dollar');
    expect(imported.grade).toBe('MS63');
    expect(imported.weight).toBeUndefined();
  });

  it('still auto-maps a bare Weight header, via the field key', () => {
    // A plain `Weight` header still maps, via the key.
    const { csv } = serviceCapturing();
    expect(csv.autoMapHeaders(['Weight'])['Weight']).toBe('weight');
  });
});

describe('the Source column', () => {
  it('preserves provenance through an export and re-import', () => {
    // Provenance survives a round trip.
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin({ source: 'quicken' })]);

    const rows = csv.parseCsv(written());
    const mapping = csv.autoMapHeaders(rows[0]);
    expect(csv.mapRowToCoin(rows[1], rows[0], mapping).source).toBe('quicken');
  });

  it('falls back to csv for an unrecognised provenance value', () => {
    // Source is a closed set in CoinRecord; a CSV cell is just text.
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Source'];
    const mapping = csv.autoMapHeaders(headers);

    expect(csv.mapRowToCoin(['Morgan Dollar', 'typed nonsense'], headers, mapping).source)
      .toBe('csv');
  });

  it('accepts provenance case-insensitively', () => {
    const { csv } = serviceCapturing();
    const headers = ['Source'];
    const mapping = csv.autoMapHeaders(headers);

    expect(csv.mapRowToCoin(['Quicken'], headers, mapping).source).toBe('quicken');
  });

  it('defaults to csv when there is no Source column at all', () => {
    const { csv } = serviceCapturing();
    const headers = ['Coin Type'];
    const mapping = csv.autoMapHeaders(headers);

    expect(csv.mapRowToCoin(['Morgan Dollar'], headers, mapping).source).toBe('csv');
  });
});

/**
 * The seven transaction fields (purchaseDate, purchasePrice, purchasedFrom,
 * soldDate, soldPrice, soldTo, transactionNotes) round-trip through CSV. The QIF
 * import fills neither counterparty (see quicken-import.service.ts).
 */
describe('the seven transaction fields', () => {
  const TRANSACTION_FIELDS = [
    'purchaseDate', 'purchasePrice', 'purchasedFrom',
    'soldDate', 'soldPrice', 'soldTo', 'transactionNotes'
  ] as const;

  it('are every one of them mappable, which is the gap this closed', () => {
    const mappable = new Set(CSV_MAPPABLE_FIELDS.filter(field => field.key).map(field => field.key));
    const missing = TRANSACTION_FIELDS.filter(field => !mappable.has(field));
    expect(missing).toEqual([]);
  });

  it('round-trips all seven through an export and re-import', () => {
    // A value surviving the whole loop is the proof that the field is exportable.
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin({
      purchaseDate: '2024-03-15',
      purchasePrice: 1250,
      purchasedFrom: 'Harbourstone Coins',
      soldDate: '2025-02-01',
      soldPrice: 1400,
      soldTo: 'Tollgate Rarities',
      transactionNotes: "18% buyer's premium, paid in two instalments"
    })]);

    const rows = csv.parseCsv(written());
    const mapping = csv.autoMapHeaders(rows[0]);
    expect(rows[0].filter(header => !mapping[header])).toEqual([]);

    const reimported = csv.mapRowToCoin(rows[1], rows[0], mapping);
    expect(reimported.purchaseDate).toBe('2024-03-15');
    expect(reimported.purchasePrice).toBe(1250);
    expect(reimported.purchasedFrom).toBe('Harbourstone Coins');
    expect(reimported.soldDate).toBe('2025-02-01');
    expect(reimported.soldPrice).toBe(1400);
    expect(reimported.soldTo).toBe('Tollgate Rarities');
    expect(reimported.transactionNotes).toBe("18% buyer's premium, paid in two instalments");
  });

  it('reads a stranger sheet headed Dealer, which is where the dealer lives', () => {
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Dealer', 'Transaction Notes', 'Notes'];
    const mapping = csv.autoMapHeaders(headers);
    const imported = csv.mapRowToCoin(
      ['Morgan Dollar', 'Heritage', 'Lot 2214, 20% premium', 'Rim nick at 4 o’clock'],
      headers,
      mapping
    );

    expect(imported.purchasedFrom).toBe('Heritage');
    expect(imported.transactionNotes).toBe('Lot 2214, 20% premium');
    // The coin's own note is a separate column and must be untouched.
    expect(imported.notes).toBe('Rim nick at 4 o’clock');
  });

  it('never routes a bare Notes column to the transaction note', () => {
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Notes'];
    const imported = csv.mapRowToCoin(
      ['Morgan Dollar', 'Rim nick'],
      headers,
      csv.autoMapHeaders(headers)
    );

    expect(imported.notes).toBe('Rim nick');
    expect(imported.transactionNotes).toBeUndefined();
  });

  it('leaves both blank when a sheet has Purchase Notes AND Sale Notes', () => {
    // Two equal claimants: the tie is left for the user (rule 3 in header-synonyms.ts).
    const { csv } = serviceCapturing();
    const mapping = csv.autoMapHeaders(['Coin Type', 'Purchase Notes', 'Sale Notes']);

    expect(mapping['Purchase Notes']).toBeUndefined();
    expect(mapping['Sale Notes']).toBeUndefined();
    expect(mapping['Coin Type']).toBe('coinType');
  });

  it('keeps the dealer out of Sold To and the buyer out of Purchased From', () => {
    // A swap here would record a sale that never happened.
    const { csv } = serviceCapturing();
    const headers = ['Seller', 'Buyer'];
    const imported = csv.mapRowToCoin(
      ['Harbourstone Coins', 'Tollgate Rarities'],
      headers,
      csv.autoMapHeaders(headers)
    );

    expect(imported.purchasedFrom).toBe('Harbourstone Coins');
    expect(imported.soldTo).toBe('Tollgate Rarities');
  });

  it('counts a coin with only a buyer as sold, now that the buyer can be mapped', () => {
    // A buyer alone marks the record as sold (import-sold.ts).
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Sold To'];
    const imported = csv.mapRowToCoin(
      ['Morgan Dollar', 'Tollgate Rarities'],
      headers,
      csv.autoMapHeaders(headers)
    );

    expect(isSoldRecord(imported)).toBe(true);
    // The buy-side dealer must not trip the same rule.
    const bought = csv.mapRowToCoin(
      ['Morgan Dollar', 'Harbourstone Coins'],
      ['Coin Type', 'Dealer'],
      csv.autoMapHeaders(['Coin Type', 'Dealer'])
    );
    expect(isSoldRecord(bought)).toBe(false);
  });
});

/**
 * Exports start with a BOM so Excel decodes `¢` and `½` correctly, and the
 * importer strips it so the first column still maps on re-import. The
 * re-import assertions are the important ones.
 */
describe('CSV exports are written as UTF-8 with a byte-order mark', () => {
  it('prefixes all three exports, which is what makes Excel decode UTF-8', () => {
    const inventory = serviceCapturing();
    inventory.csv.exportCsv([coin()]);
    expect(inventory.written().startsWith(BOM)).toBe(true);
    expect(inventory.mimeType()).toBe('text/csv;charset=utf-8');

    const template = serviceCapturing();
    template.csv.downloadCsvTemplate();
    expect(template.written().startsWith(BOM)).toBe(true);

    const insurance = serviceCapturing();
    insurance.csv.exportInsuranceCsv([coin()]);
    expect(insurance.written().startsWith(BOM)).toBe(true);
  });

  it('re-imports its own export with the first column still mapped', () => {
    // `Coin Type` is the first column; with an unstripped BOM it would match nothing.
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin()]);

    const rows = csv.parseCsv(written());
    expect(rows[0][0]).toBe('Coin Type');

    const mapping = csv.autoMapHeaders(rows[0]);
    expect(rows[0].filter(header => !mapping[header])).toEqual([]);
    expect(csv.mapRowToCoin(rows[1], rows[0], mapping).coinType).toBe('Morgan Dollar');
  });

  it('round-trips the cent sign and the fraction that caused the report', () => {
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin({ denomination: '½ Cent', notes: 'Marked 25¢ on the flip' })]);

    const rows = csv.parseCsv(written());
    const mapping = csv.autoMapHeaders(rows[0]);
    const reimported = csv.mapRowToCoin(rows[1], rows[0], mapping);

    expect(reimported.denomination).toBe('½ Cent');
    expect(reimported.notes).toBe('Marked 25¢ on the flip');
    // No stray Â anywhere in the file.
    expect(written()).not.toContain('Â');
  });

  it('strips a BOM from a file written by some other program too', () => {
    const csv = new CsvService();
    const rows = csv.parseCsv(`${BOM}Coin Type,Year\nMorgan Dollar,1881\n`);
    expect(rows[0]).toEqual(['Coin Type', 'Year']);
    expect(csv.autoMapHeaders(rows[0])['Coin Type']).toBe('coinType');
  });
});

describe('the blank template', () => {
  it('omits Source, which nobody filling in a blank sheet should supply', () => {
    const { csv, written } = serviceCapturing();
    csv.downloadCsvTemplate();

    const headers = csv.parseCsv(written())[0];
    expect(headers).not.toContain('Source');
    expect(headers).toContain('Coin Type');
  });

  it('keeps every example row aligned with the header row', () => {
    // Example rows are keyed by field, so adding a field can't shift values a column.
    const { csv, written } = serviceCapturing();
    csv.downloadCsvTemplate();

    const rows = csv.parseCsv(written());
    const width = rows[0].length;
    for (const row of rows.slice(1)) {
      expect(row).toHaveLength(width);
    }
  });

  it('auto-maps completely, which is what makes it a usable template', () => {
    const { csv, written } = serviceCapturing();
    csv.downloadCsvTemplate();

    const headers = csv.parseCsv(written())[0];
    const mapping = csv.autoMapHeaders(headers);
    expect(headers.filter(header => !mapping[header])).toEqual([]);
  });

  it('demonstrates a unit-carrying weight in GRAMS, and no ounce form at all', () => {
    // Template examples show only forms safe in a grams column: a gram value with
    // its unit, nothing in ounces. parseNumericCell ignores units, so '0.7734 ozt'
    // or '1/10 oz' would be recorded as grams.
    const written = (() => {
      const { csv, written } = serviceCapturing();
      csv.downloadCsvTemplate();
      return written();
    })();

    expect(written).toContain('Weight (g)');
    expect(written).toContain('26.73 g');

    expect(written).not.toContain('ozt');
    expect(written).not.toContain('1/10 oz');
    expect(written).not.toContain('(oz)');
  });
});
