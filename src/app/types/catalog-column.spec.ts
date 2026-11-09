/*
 * catalog-column.spec.ts — the Catalogue Ref. column in the inventory grid.
 * WHY THIS IS A SEPARATE FILE FROM inventory-columns.spec.ts
 *   inventory-columns.ts is shared ground: several pieces of work are adding
 *   columns to it at the same time. Keeping this column's tests in their own
 *   file means two changes to the same array do not become one merge conflict
 *   in one spec, and the invariants below are re-checked from a second place
 *   rather than edited in place.
 *
 * WHAT IS AT RISK
 *   - THE ORDERING INVARIANTS. inventory-columns.ts's header states two that
 *     must never break: Year is immediately followed by Mint Mark, and Cert
 *     sits immediately before Grade. Inserting a column is the one operation
 *     that can break them, so the insertion is tested against them here as
 *     well as in the original spec.
 *
 *   - THE COLUMN BEING ON BY DEFAULT. Most collectors of modern coins will
 *     never record a catalogue reference, and this grid is already dense
 *     enough that an always-empty column pushes the money columns off the
 *     right-hand edge. It must start switched OFF.
 *
 *   - THE CELL RENDERING "undefined" OR LOSING THE NUMBER. The lookup list is
 *     an optional argument, exactly like spot prices, so a caller that does
 *     not have it must still render something true.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultVisibleColumns,
  formatInventoryCell,
  inventoryColumnLabels,
  inventoryColumnOrder
} from './inventory-columns';
import { CatalogOption } from './catalog-reference';
import { CoinRecord } from './coin.model';

const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true }
];

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: 'coin-1', denomination: 'Denarius', year: '', coinType: '',
    category: '', country: 'Roman Empire', grade: '', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

describe('the Catalogue Ref. column', () => {
  it('appears exactly once in the canonical order', () => {
    const occurrences = inventoryColumnOrder.filter(column => column === 'catalogReference');
    expect(occurrences).toHaveLength(1);
  });

  it('has a header', () => {
    expect(inventoryColumnLabels['catalogReference']).toBe('Catalogue Ref.');
  });

  it('is OFF by default', () => {
    // A column almost every user of modern coins would leave empty. The
    // column picker is one tick away for the people who want it.
    expect(defaultVisibleColumns).not.toContain('catalogReference');
  });

  it('leaves Mint Mark immediately after Year', () => {
    const year = inventoryColumnOrder.indexOf('year');
    expect(inventoryColumnOrder.indexOf('mintMark') - year).toBe(1);
  });

  it('leaves Cert immediately before Grade', () => {
    const cert = inventoryColumnOrder.indexOf('certNumber');
    expect(inventoryColumnOrder.indexOf('grade') - cert).toBe(1);
  });

  it('sits next to Variety, which is where these references are today', () => {
    // Not decoration. coin-signature.ts documents a live record whose
    // `variety` reads "Sear 6819" -- the user had nowhere else to put it. The
    // two columns side by side are what make it obvious that the reference
    // can be moved out of the free-text field and into its own.
    const variety = inventoryColumnOrder.indexOf('variety');
    const reference = inventoryColumnOrder.indexOf('catalogReference');
    expect(Math.abs(reference - variety)).toBe(1);
  });
});

describe('formatInventoryCell — catalogReference column', () => {
  it('shows the catalogue and the number as one reference', () => {
    const coin = makeCoin({ catalogId: 1, catalogNumber: '6819' });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, CATALOGS)).toBe('Sear 6819');
  });

  it('shows the ordinary dash when the coin has no reference', () => {
    // Every coin that existed before migration 012, which is all of them.
    expect(formatInventoryCell(makeCoin(), 'catalogReference', undefined, CATALOGS)).toBe('—');
  });

  it('shows the number alone when no catalogue list was passed in', () => {
    // The list is an optional argument, like spotPrices, so that this stays
    // one pure function testable with a plain object. A caller without the
    // list (the report renderer, today) still prints the number the user
    // typed rather than an em-dash that hides it.
    const coin = makeCoin({ catalogId: 1, catalogNumber: '6819' });
    expect(formatInventoryCell(coin, 'catalogReference')).toBe('6819');
  });

  it('shows the number alone when the catalogue is no longer in the list', () => {
    const coin = makeCoin({ catalogId: 404, catalogNumber: '6819' });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, CATALOGS)).toBe('6819');
  });

  it('shows the catalogue alone when no number has been recorded', () => {
    const coin = makeCoin({ catalogId: 3, catalogNumber: '' });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, CATALOGS)).toBe('Hendin');
  });

  it('never renders the word undefined', () => {
    // The two half-populated states are the ones that produce
    // "undefined 6819" / "Sear undefined" if anything concatenates by hand.
    for (const coin of [
      makeCoin({ catalogNumber: '6819' }),
      makeCoin({ catalogId: 1 })
    ]) {
      expect(formatInventoryCell(coin, 'catalogReference', undefined, CATALOGS))
        .not.toMatch(/undefined/);
    }
  });

  it('leaves every other column untouched when a catalogue list is supplied', () => {
    // The new fourth parameter must be inert everywhere else, exactly as the
    // spotPrices parameter is.
    const coin = makeCoin({ coinType: 'Shekel', grade: 'VF', catalogId: 1, catalogNumber: '1A' });
    for (const column of inventoryColumnOrder) {
      if (column === 'catalogReference') continue;
      expect(formatInventoryCell(coin, column, undefined, CATALOGS))
        .toBe(formatInventoryCell(coin, column));
    }
  });
});
