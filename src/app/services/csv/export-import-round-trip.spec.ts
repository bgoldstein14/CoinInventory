/**
 * Tests that Export -> CSV produces a file the importer can fully read back.
 *
 * THE BUG THESE EXIST FOR
 * -----------------------
 * The CSV modal tells the user that an exported file doubles as a template,
 * because every column will auto-map. That was not true. `exportCsv()` kept its
 * own hand-written list of 22 header labels, and `CSV_MAPPABLE_FIELDS` -- which
 * drives both auto-mapping and the mapping dropdown -- listed only 21. The
 * missing one was `Source`. It could not auto-map, and since the dropdown is
 * built from the same list, it could not be mapped by hand either. The one file
 * advertised as a ready-made template was the one file with an unmappable
 * column in it.
 *
 * The fix was structural rather than a one-line addition: the export now
 * DERIVES its columns from `CSV_MAPPABLE_FIELDS`, so the two cannot drift
 * again. The first test below is the one that would have caught the original
 * bug, and it now holds by construction.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { CSV_MAPPABLE_FIELDS, CsvService } from '../csv.service';

/**
 * CsvService has no injected dependencies, so it can be constructed directly.
 *
 * `downloadBlob` is replaced because it reaches for `document` to trigger a
 * browser download, and these specs run in Node with no DOM. Swapping it for a
 * capture lets the tests assert on the REAL generated file content rather than
 * on some reimplementation of it.
 */
function serviceCapturing(): { csv: CsvService; written: () => string } {
  const csv = new CsvService();
  let content = '';
  (csv as unknown as Record<string, unknown>)['downloadBlob'] = vi.fn(
    (text: string) => { content = text; }
  );
  return { csv, written: () => content };
}

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Dollar', year: '1881', coinType: 'Morgan Dollar',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: 'PCGS',
    certNumber: '12345678', variety: '', mintMark: 'S', composition: '90% Silver',
    purchaseDate: '2024-03-15', purchasePrice: 1250, currentValue: 1400,
    notes: '', imagePaths: [], tags: [], source: 'quicken',
    ...overrides
  };
}

describe('Export -> CSV round trip', () => {
  it('every exported header auto-maps on re-import', () => {
    // The regression test for the original defect. Before the fix, "Source"
    // came back unmapped.
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
    csv.exportCsv([coin({ notes: 'Toned, with a comma', weight: 0.7734 })]);

    const rows = csv.parseCsv(written());
    const headers = rows[0];
    const mapping = csv.autoMapHeaders(headers);
    const reimported = csv.mapRowToCoin(rows[1], headers, mapping);

    expect(reimported.coinType).toBe('Morgan Dollar');
    expect(reimported.grade).toBe('MS63');
    expect(reimported.purchasePrice).toBe(1250);
    expect(reimported.weight).toBe(0.7734);
    // Quoted field containing a comma must come back whole.
    expect(reimported.notes).toBe('Toned, with a comma');
  });
});

describe('the Source column', () => {
  it('preserves provenance through an export and re-import', () => {
    // A coin that originally came from Quicken stays 'quicken'. Before Source
    // was importable, every re-imported row was relabelled 'csv', quietly
    // rewriting where the collection's data came from.
    const { csv, written } = serviceCapturing();
    csv.exportCsv([coin({ source: 'quicken' })]);

    const rows = csv.parseCsv(written());
    const mapping = csv.autoMapHeaders(rows[0]);
    expect(csv.mapRowToCoin(rows[1], rows[0], mapping).source).toBe('quicken');
  });

  it('falls back to csv for an unrecognised provenance value', () => {
    // Provenance is a closed set in CoinRecord, and a CSV cell is just text.
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

describe('the blank template', () => {
  it('omits Source, which nobody filling in a blank sheet should supply', () => {
    const { csv, written } = serviceCapturing();
    csv.downloadCsvTemplate();

    const headers = csv.parseCsv(written())[0];
    expect(headers).not.toContain('Source');
    expect(headers).toContain('Coin Type');
  });

  it('keeps every example row aligned with the header row', () => {
    // The example rows used to be positional arrays that had to match
    // CSV_MAPPABLE_FIELDS in order AND length by hand, so adding one field
    // shifted every example value a column to the left. They are keyed by
    // field now, which is what this asserts.
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

  it('demonstrates a unit-carrying and a fractional weight', () => {
    // The examples double as documentation, so they should show the forms the
    // parser now handles rather than only the easy case.
    const written = (() => {
      const { csv, written } = serviceCapturing();
      csv.downloadCsvTemplate();
      return written();
    })();

    expect(written).toContain('ozt');
    expect(written).toContain('1/10 oz');
  });
});
