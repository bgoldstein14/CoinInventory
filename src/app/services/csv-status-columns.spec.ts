 /*
  * Status and Storage through CsvService.mapRowToCoin. `collectionStatus` is a
  * closed set of five tokens, so imported text is normalised on the way in and
  * an unknown word becomes 'owned'. `storageLocation` is free text, stored as typed.
  */

import { describe, expect, it } from 'vitest';
import { CsvService } from './csv.service';
import { CSV_MAPPABLE_FIELDS } from './csv/mappable-fields';

const csv = new CsvService();

/** Imports a one-row sheet with the given headers, auto-mapping the columns. */
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
    // These headers come from the export, so they must auto-map.
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
    // The grid label as a user would type it.
    expect(importRow(['Denomination', 'Status'], ['Dollar', 'For Sale']).collectionStatus)
      .toBe('for-sale');
  });

  it('falls back to Owned for an unrecognised word rather than storing it', () => {
    // An unknown status must not reach the record.
    expect(importRow(['Denomination', 'Status'], ['Dollar', 'maybe']).collectionStatus)
      .toBe('owned');
  });

  it('treats a sheet with no Status column as a sheet of owned coins', () => {
    // No Status column (every older file) means owned.
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
    // Unlike Status, an absent storage location stays absent.
    expect(importRow(['Denomination'], ['Dollar']).storageLocation).toBeUndefined();
  });
});
