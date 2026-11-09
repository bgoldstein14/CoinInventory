 /*
 * csv-catalog-columns.spec.ts — the catalogue reference through CSV / Excel.
 * ---- WHAT IS AT RISK HERE, AND IT IS NOT THE OBVIOUS THING ----
 * The coin stores TWO fields: `catalogId`, a foreign key into the Catalogs
 * table, and `catalogNumber`, free text. Only one of those is meaningful to
 * a human with a spreadsheet, and getting that wrong in either direction is
 * expensive:
 *
 *   - `catalogId` is an INTEGER that means something only inside THIS
 *     database. It is in the mapping list so that the app's own
 *     Export -> CSV round-trips (which is the same reason `source` is in the
 *     list), and for no other reason.
 *
 *   - A STRANGER'S COLUMN HEADED `Catalog` HOLDS "Sear", NOT "3". If
 *     `catalog`/`catalogue` were a synonym of `catalogId`, that column would
 *     auto-map onto the foreign key, the importer would copy the cell
 *     verbatim, and the record would carry `catalogId: "Sear"` — bound to an
 *     INT parameter at save time. The server normalises it to NULL rather
 *     than failing (see db/coin-fields.ts), so the user would lose the
 *     attribution silently, with a confident-looking mapping screen having
 *     told him it was handled.
 *
 * So every human-sounding synonym points at `catalogNumber`, which is free
 * text and can hold "Sear 6819" harmlessly — the reference ends up in the
 * field where it is visible, searchable and editable, which is strictly
 * better than where it is today (the Variety box). `catalogId` gets NO
 * synonyms at all. That asymmetry is the point of this file.
 *
 * It lives at services/ rather than services/csv/ because the catalogue work
 * is allowed to touch exactly one thing in that folder — the
 * CSV_MAPPABLE_FIELDS array — and because this is about the importer's
 * behaviour rather than about the mapping helpers.
  */

import { describe, expect, it } from 'vitest';
import { CsvService } from './csv.service';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';
import { mapHeadersToFields, matchHeaderToField } from './csv/header-synonyms';

const csv = new CsvService();

/** Import a one-row sheet with the given headers, auto-mapping the columns. */
function importRow(headers: string[], row: string[]) {
  return csv.mapRowToCoin(row, headers, csv.autoMapHeaders(headers));
}

describe('both fields are importable and exportable at all', () => {
  it('offers the catalogue number in the mapping list', () => {
    expect(CSV_MAPPABLE_FIELDS).toContainEqual({ key: 'catalogNumber', label: 'Catalog Number' });
  });

  it('offers the catalogue id in the mapping list', () => {
    // Deliberately labelled "Catalog Id", not "Catalog": the label is also
    // an exact auto-map target, and a column headed `Catalog` in somebody's
    // workbook holds a catalogue NAME. See the file header.
    expect(CSV_MAPPABLE_FIELDS).toContainEqual({ key: 'catalogId', label: 'Catalog Id' });
  });

  it('auto-maps the app\'s own exported headers with no help from the user', () => {
    // CSV_MAPPABLE_FIELDS drives the export header row too, so a header that
    // did not auto-map would mean the app's own exported file could not be
    // read back -- the defect export-import-round-trip.spec.ts exists for.
    const mapping = csv.autoMapHeaders(['Catalog Id', 'Catalog Number']);
    expect(mapping['Catalog Id']).toBe('catalogId');
    expect(mapping['Catalog Number']).toBe('catalogNumber');
  });

  it('appears in the exported header row', () => {
    const headers = csv.exportHeaderLabels();
    expect(headers).toContain('Catalog Id');
    expect(headers).toContain('Catalog Number');
  });
});

describe('a stranger\'s catalogue column lands on the NUMBER, never on the id', () => {
  it('maps the headings people actually write onto catalogNumber', () => {
    for (const heading of [
      'Catalog', 'Catalogue', 'Cat No', 'Catalog No', 'Catalogue No',
      'Catalog #', 'Reference', 'Catalog Ref', 'Attribution No', 'KM'
    ]) {
      expect(matchHeaderToField(heading), `${heading} should map to catalogNumber`)
        .toBe('catalogNumber');
    }
  });

  it('never maps a word-shaped heading onto the integer foreign key', () => {
    // THE test in this file. A column headed `Catalog` holding "Sear" must
    // not be aimed at an INT column. Nothing but the exact key and label may
    // reach catalogId.
    for (const heading of ['Catalog', 'Catalogue', 'Cat No', 'Reference', 'KM']) {
      expect(matchHeaderToField(heading)).not.toBe('catalogId');
    }
  });

  it('leaves a bare `Ref` unplaceable, as header-synonyms.ts already decided', () => {
    // Not an oversight and not this feature's call to overturn: `Ref` over a
    // column of slab numbers is a certification reference, and the file's
    // own rule 1 refuses a word that could mean several things. An existing
    // test in csv/header-synonyms.spec.ts pins it; this one records that the
    // catalogue work looked at it and deferred.
    expect(matchHeaderToField('Ref')).toBeUndefined();
  });

  it('keeps `Cat` meaning Category, as it did before this feature existed', () => {
    // `cat` has been a Category synonym since before catalogues were a
    // field. Re-aiming it would move data between two unrelated columns for
    // every user who has mapped such a sheet before.
    expect(matchHeaderToField('Cat')).toBe('category');
  });

  it('still refuses genuinely ambiguous headings', () => {
    // Rule 1 of header-synonyms.ts: no synonym for a word that could mean
    // several things. `Number` and `No` on their own could be a cert number,
    // a stock number or a catalogue number.
    expect(matchHeaderToField('Number')).toBeUndefined();
    expect(matchHeaderToField('No')).toBeUndefined();
  });

  it('lets an exact `Catalog Number` heading beat the loose `Catalog` one', () => {
    // Exact beats synonym, and a tie leaves both blank -- the two conflict
    // rules in header-synonyms.ts, applied to a sheet that has both columns.
    const mapping = mapHeadersToFields(['Catalog', 'Catalog Number']);
    expect(mapping['Catalog Number']).toBe('catalogNumber');
    expect(mapping['Catalog']).toBeUndefined();
  });
});

describe('importing the cells', () => {
  it('reads a reference into catalogNumber exactly as written', () => {
    const coin = importRow(['Denomination', 'Catalog Number'], ['Denarius', 'RIC II.1 234']);
    expect(coin.catalogNumber).toBe('RIC II.1 234');
  });

  it('puts a stranger\'s whole reference somewhere visible rather than nowhere', () => {
    // "Sear 6819" under a heading of `Catalog` is not a catalogue id and
    // never will be. Landing it in the number field means the user can see
    // it, search it and split it in the editor. The alternative -- leaving
    // the column unmapped -- loses it.
    const coin = importRow(['Denomination', 'Catalog'], ['Tetradrachm', 'Sear 6819']);
    expect(coin.catalogNumber).toBe('Sear 6819');
  });

  it('leaves both fields absent when the sheet says nothing about catalogues', () => {
    // Not '' and not 0. The overwhelming majority of imported rows, and the
    // absence has to survive to the server as "no reference recorded".
    const coin = importRow(['Denomination', 'Year'], ['Dollar', '1881']);
    expect(coin.catalogNumber).toBeUndefined();
    expect(coin.catalogId).toBeUndefined();
  });

  it('round-trips an id out of the app and back in', () => {
    // The only thing the id column is for. The cell arrives as text, which
    // is why the server normalises it back to an integer -- see
    // db/catalog-columns.spec.ts.
    const coin = importRow(['Catalog Id', 'Catalog Number'], ['3', '6819']);
    expect(String(coin.catalogId)).toBe('3');
    expect(coin.catalogNumber).toBe('6819');
  });
});
