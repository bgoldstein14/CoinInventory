 /*
 * csv-status-columns.spec.ts — Status and Storage through the CSV importer.
 * ---- WHAT IS AT RISK HERE ----
 * `collectionStatus` is a CLOSED SET of five tokens that decides whether a
 * coin counts towards the value of the collection. A CSV cell is just text
 * typed by a human into a spreadsheet. Letting that text through unchecked
 * would put arbitrary strings into a field the rest of the app treats as one
 * of five values — the identical hazard that made `source` a validated field
 * rather than a copied one (see KNOWN_COIN_SOURCES in csv.service.ts).
 *
 * The failure mode is specific and nasty: an unrecognised status would not
 * throw, it would just sit there, and `isHeldInCollection` would have to make
 * something up about a coin the owner does have. The answer is to normalise
 * on the way in, so an unknown word becomes Owned at the border and nothing
 * downstream ever sees it.
 *
 * `storageLocation` is the opposite and is here to prove it: free text, no
 * validation, stored exactly as typed.
 *
 * This file lives at services/ rather than services/csv/ on purpose — it is
 * about CsvService.mapRowToCoin, not about the mapping helpers in that folder.
  */

import { describe, expect, it } from 'vitest';
import { CsvService } from './csv.service';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';

const csv = new CsvService();

/** Import a one-row sheet with the given headers, auto-mapping the columns. */
function importRow(headers: string[], row: string[]) {
  return csv.mapRowToCoin(row, headers, csv.autoMapHeaders(headers));
}

describe('both new fields are importable and exportable at all', () => {
  it('offers Status in the mapping list', () => {
    expect(CSV_MAPPABLE_FIELDS).toContainEqual({ key: 'collectionStatus', label: 'Status' });
  });

  it('offers Storage in the mapping list', () => {
    expect(CSV_MAPPABLE_FIELDS).toContainEqual({ key: 'storageLocation', label: 'Storage' });
  });

  it('auto-maps both headers with no help from the user', () => {
    // CSV_MAPPABLE_FIELDS drives the export header row as well, so a header
    // that does not auto-map would mean the app's own exported file could not
    // be read back -- the exact defect export-import-round-trip.spec.ts exists
    // to prevent.
    const mapping = csv.autoMapHeaders(['Status', 'Storage']);
    expect(mapping['Status']).toBe('collectionStatus');
    expect(mapping['Storage']).toBe('storageLocation');
  });
});

describe('importing a Status cell', () => {
  it('reads a known status', () => {
    expect(importRow(['Denomination', 'Status'], ['Dollar', 'wanted']).collectionStatus)
      .toBe('wanted');
  });

  it('reads the human spelling of For Sale', () => {
    // What somebody types into a spreadsheet, and what the app's own grid
    // shows them.
    expect(importRow(['Denomination', 'Status'], ['Dollar', 'For Sale']).collectionStatus)
      .toBe('for-sale');
  });

  it('falls back to Owned for an unrecognised word rather than storing it', () => {
    // The closed-set guarantee. 'maybe' must not end up in the record.
    expect(importRow(['Denomination', 'Status'], ['Dollar', 'maybe']).collectionStatus)
      .toBe('owned');
  });

  it('treats a sheet with no Status column as a sheet of owned coins', () => {
    // Which is every sheet anyone has today, including every file this app
    // exported before the feature existed.
    expect(importRow(['Denomination'], ['Dollar']).collectionStatus).toBe('owned');
  });

  it('treats a blank Status cell as Owned', () => {
    expect(importRow(['Denomination', 'Status'], ['Dollar', '']).collectionStatus).toBe('owned');
  });
});

describe('importing a Storage cell', () => {
  it('stores the text exactly as typed, punctuation and all', () => {
    expect(importRow(['Denomination', 'Storage'], ['Dollar', 'Dansco 7070, page 4']).storageLocation)
      .toBe('Dansco 7070, page 4');
  });

  it('does not invent a value when the column is absent', () => {
    // Unlike Status, an absent storage location really is absent.
    expect(importRow(['Denomination'], ['Dollar']).storageLocation).toBeUndefined();
  });
});
