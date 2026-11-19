 /*
  * Catalogue references through the CSV/Excel importer and Export -> CSV: one
  * "Catalog References" column written as `Sear 6819; RIC 123`. On import each
  * part takes the catalogue its name starts with; anything else is kept whole
  * as a number with no catalogue.
  */

import { describe, expect, it, vi } from 'vitest';
import { CsvService } from './csv.service';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';
import { mapHeadersToFields, matchHeaderToField } from './csv/header-synonyms';
import { CatalogOption } from '../types/catalog-reference';
import { CoinRecord } from '../types/coin.model';

const csv = new CsvService();

const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 2, name: 'RIC', sortOrder: 2, isActive: true },
  { catalogId: 10, name: 'Cohen', sortOrder: 10, isActive: true },
  { catalogId: 15, name: 'Krause (KM)', sortOrder: 15, isActive: true }
];

/** Imports a one-row sheet with the given headers, auto-mapping the columns. */
function importRow(headers: string[], row: string[]) {
  return csv.mapRowToCoin(row, headers, csv.autoMapHeaders(headers), [], CATALOGS);
}

describe('the Catalog References field', () => {
  it('is the one catalogue field in the mapping list', () => {
    expect(CSV_MAPPABLE_FIELDS).toContainEqual({ key: 'catalogRefs', label: 'Catalog References' });
    expect(CSV_MAPPABLE_FIELDS.map(f => f.key)).not.toContain('catalogId');
    expect(CSV_MAPPABLE_FIELDS.map(f => f.key)).not.toContain('catalogNumber');
  });

  it('auto-maps the app\'s own exported header', () => {
    expect(csv.autoMapHeaders(['Catalog References'])['Catalog References']).toBe('catalogRefs');
  });

  it('maps the headings people actually write', () => {
    for (const heading of [
      'Catalog', 'Catalogue', 'Cat No', 'Catalog No', 'Catalog Number', 'Catalogue No',
      'Catalog #', 'Reference', 'Catalog Ref', 'Attribution No', 'KM'
    ]) {
      expect(matchHeaderToField(heading), heading).toBe('catalogRefs');
    }
  });

  it('keeps the existing refusals', () => {
    expect(matchHeaderToField('Ref')).toBeUndefined();
    expect(matchHeaderToField('Cat')).toBe('category');
    expect(matchHeaderToField('Number')).toBeUndefined();
    expect(matchHeaderToField('No')).toBeUndefined();
  });

  it('lets the exact header beat a loose synonym', () => {
    const mapping = mapHeadersToFields(['Catalog', 'Catalog References']);
    expect(mapping['Catalog References']).toBe('catalogRefs');
    expect(mapping['Catalog']).toBeUndefined();
  });
});

describe('importing the cell', () => {
  it('splits it into references and matches catalogue names', () => {
    const coin = importRow(['Denomination', 'Catalog References'], ['Denarius', 'RIC 123; Sear 6819; Krause (KM) 110']);
    expect(coin.catalogRefs).toEqual([
      { catalogId: 2, catalogNumber: '123' },
      { catalogId: 1, catalogNumber: '6819' },
      { catalogId: 15, catalogNumber: '110' }
    ]);
  });

  it('keeps a reference with an unknown catalogue whole, as a number', () => {
    const coin = importRow(['Denomination', 'Catalog'], ['Tetradrachm', 'Svoronos 7']);
    expect(coin.catalogRefs).toEqual([{ catalogId: null, catalogNumber: 'Svoronos 7' }]);
  });

  it('ignores stray separators and spaces', () => {
    const coin = importRow(['Denomination', 'Catalog'], ['Denarius', ' Sear 6819 ;; RIC 123; ']);
    expect(coin.catalogRefs).toHaveLength(2);
  });

  it('adds references from every column mapped to them', () => {
    const headers = ['Denomination', 'Sear', 'RIC'];
    const mapping = { Denomination: 'denomination', Sear: 'catalogRefs', RIC: 'catalogRefs' };
    const coin = csv.mapRowToCoin(['Denarius', 'Sear 6819', 'RIC 123'], headers, mapping, [], CATALOGS);
    expect(coin.catalogRefs).toEqual([
      { catalogId: 1, catalogNumber: '6819' },
      { catalogId: 2, catalogNumber: '123' }
    ]);
  });

  it('leaves references absent when the sheet says nothing about catalogues', () => {
    const coin = importRow(['Denomination', 'Year'], ['Dollar', '1881']);
    expect(coin.catalogRefs).toBeUndefined();
  });
});

describe('exporting', () => {
  it('writes every reference into one column, and that round-trips', () => {
    expect(csv.exportHeaderLabels()).toContain('Catalog References');

    const refs = [
      { catalogId: 2, catalogNumber: '123' },
      { catalogId: 1, catalogNumber: '6819' },
      { catalogId: null, catalogNumber: '77-A' }
    ];
    const coin = { id: 'x', denomination: 'Denarius', catalogRefs: refs } as unknown as CoinRecord;

    let written = '';
    const spy = vi.spyOn(csv as unknown as { downloadCsv: (lines: string[], name: string) => void }, 'downloadCsv')
      .mockImplementation((lines: string[]) => { written = lines.join('\n'); });
    csv.exportCsv([coin], CATALOGS);
    spy.mockRestore();

    const rows = csv.parseCsv(written);
    const column = rows[0].indexOf('Catalog References');
    expect(rows[1][column]).toBe('RIC 123; Sear 6819; 77-A');

    const back = csv.mapRowToCoin(rows[1], rows[0], csv.autoMapHeaders(rows[0]), [], CATALOGS);
    expect(back.catalogRefs).toEqual(refs);
  });
});
