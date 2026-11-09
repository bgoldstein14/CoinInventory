/**
 * Tests that Export -> CSV produces a file the importer can fully read back.
 *
 * WHY THEY MATTER
 *
 * The CSV modal tells the user that an exported file doubles as a template,
 * because every column will auto-map. That only holds while the export's
 * columns and `CSV_MAPPABLE_FIELDS` -- which drives both auto-mapping and the
 * mapping dropdown -- stay in step. A hand-written header list drifts from
 * that list (it once grew a `Source` column the importer could map neither
 * automatically nor by hand), so the export now DERIVES its columns from it.
 * The first test below holds by construction and is the one that catches a
 * regression there.
 */
import { describe, expect, it, vi } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { CSV_MAPPABLE_FIELDS, CsvService } from '../csv.service';
import { BOM } from './byte-order-mark';

/**
 * CsvService has no injected dependencies, so it can be constructed directly.
 *
 * `downloadBlob` is replaced because it reaches for `document` to trigger a
 * browser download, and these specs run in Node with no DOM. Swapping it for a
 * capture lets the tests assert on the REAL generated file content rather than
 * on some reimplementation of it.
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
    // 26.73 is the Morgan dollar weight in GRAMS, which is what the weight
    // field holds since migration 008.
    csv.exportCsv([coin({ notes: 'Toned, with a comma', weight: 26.73 })]);

    const rows = csv.parseCsv(written());
    const headers = rows[0];
    const mapping = csv.autoMapHeaders(headers);
    const reimported = csv.mapRowToCoin(rows[1], headers, mapping);

    expect(reimported.coinType).toBe('Morgan Dollar');
    expect(reimported.grade).toBe('MS63');
    expect(reimported.purchasePrice).toBe(1250);
    expect(reimported.weight).toBe(26.73);
    // Quoted field containing a comma must come back whole.
    expect(reimported.notes).toBe('Toned, with a comma');
  });
});

/**
 * The weight column's unit, and the compatibility decision that came with it.
 *
 * `Coins.Weight` held TROY OUNCES until server/migrations/008-weight-to-grams.sql
 * multiplied every stored value by 31.1034768. The CSV label moved with it,
 * from `Weight (oz)` to `Weight (g)`, which deliberately breaks auto-mapping
 * for files exported before the change.
 *
 * That break is the behaviour under test here, because it is the kind of thing
 * a later reader "fixes" out of kindness. Recognising the old header would
 * import a Morgan dollar as 0.7734 GRAMS -- a 31x understatement, silent, and
 * entirely plausible-looking in a grid. Recognising it AND converting would be
 * arithmetically right but would make a cell's meaning depend on the text
 * above it, so a spreadsheet already converted to grams but left with the old
 * heading would be multiplied by 31 instead. An unmapped column is visible on
 * the mapping screen and costs one dropdown selection; neither silent error is
 * recoverable.
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
    // The whole point. If this assertion ever fails, read the block comment
    // above before changing it -- a passing "fix" here is a silent 31x data
    // error for every pre-008 export anyone re-imports.
    const { csv } = serviceCapturing();
    expect(csv.autoMapHeaders(['Weight (oz)'])['Weight (oz)']).toBeUndefined();
  });

  it('leaves the rest of an old file importing normally', () => {
    // An unmapped weight column must not poison the row around it. This is the
    // same guarantee the removed Dealer column was given.
    const { csv } = serviceCapturing();
    const headers = ['Coin Type', 'Weight (oz)', 'Grade'];
    const mapping = csv.autoMapHeaders(headers);
    const imported = csv.mapRowToCoin(['Morgan Dollar', '0.7734', 'MS63'], headers, mapping);

    expect(imported.coinType).toBe('Morgan Dollar');
    expect(imported.grade).toBe('MS63');
    expect(imported.weight).toBeUndefined();
  });

  it('still auto-maps a bare Weight header, via the field key', () => {
    // autoMapHeaders matches on the key as well as the label, so a plain
    // `Weight` column keeps working. It carries no unit either way, so there
    // is nothing extra to be inferred from it -- and no claim being made about
    // what unit the numbers under it are in.
    const { csv } = serviceCapturing();
    expect(csv.autoMapHeaders(['Weight'])['Weight']).toBe('weight');
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

/**
 * The byte-order mark, and the silent trap that came with adding it.
 *
 * Without a BOM, Excel decodes a UTF-8 export as windows-1252 and every `¢`
 * and `½` in a denomination comes out as nonsense: both are two-byte UTF-8
 * sequences beginning `0xC2`, which windows-1252 renders as a stray `Â`, and
 * both are ordinary content in a US coin inventory ("½ Cent", "25¢").
 *
 * Adding the BOM on its own is a net loss, though: if the importer does not
 * strip one, re-importing our own export leaves the FIRST column unmapped
 * and says nothing about it. The re-import assertions below are the real
 * test; the "starts with a BOM" ones only stop it being removed again.
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
    // THE regression test. `Coin Type` is the first exported column; with a
    // BOM glued to it and no stripping, it reads `﻿Coin Type`, matches
    // nothing, and every coin loses its type without a word of warning.
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
    // And no stray Â anywhere in the file itself.
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
    // The example rows are keyed by field, not positional arrays: a
    // positional array has to match CSV_MAPPABLE_FIELDS in order AND length
    // by hand, so adding one field shifts every example value a column to
    // the left. This asserts the alignment.
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
    // The examples double as documentation, so they should show the forms the
    // parser handles rather than only the easy case -- but only the forms that
    // are SAFE in this column.
    //
    // 'ozt' and '1/10 oz' are NOT safe here. parseNumericCell reads the
    // NUMBER and discards whatever unit follows it, and resolves a fraction
    // on sight, so in a GRAMS column '0.7734 ozt' records 0.7734 grams and
    // '1/10 oz' records a tenth of a gram. In the template's one job -- being
    // the file people copy -- that is a trap.
    //
    // So: a gram example WITH its unit (safe, and it makes the unit
    // unmissable), and nothing that looks like an ounce. The negative
    // assertions are the
    // point of the test -- they stop the old examples being restored by
    // somebody who reads the parser's tolerance as an invitation.
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
