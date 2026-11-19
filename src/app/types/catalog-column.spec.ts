/*
 * Tests for the Catalogue Ref. column in the inventory grid: it keeps the
 * column-order invariants (Mint Mark right after Year, Cert right before
 * Grade), is hidden by default, and renders correctly with or without the
 * optional catalogue lookup list.
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
    // Usually empty for modern coins; users can enable it in the column picker.
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
    // References are often typed into Variety (e.g. "Sear 6819"), so keep them adjacent.
    const variety = inventoryColumnOrder.indexOf('variety');
    const reference = inventoryColumnOrder.indexOf('catalogReference');
    expect(Math.abs(reference - variety)).toBe(1);
  });
});

describe('formatInventoryCell — catalogReference column', () => {
  const ric = { catalogId: 2, catalogNumber: '123' };
  const sear = { catalogId: 1, catalogNumber: '6819' };
  const LIST: CatalogOption[] = [...CATALOGS, { catalogId: 2, name: 'RIC', sortOrder: 2, isActive: true }];

  it('shows the main (Sear) reference and how many others there are', () => {
    const coin = makeCoin({ catalogRefs: [ric, sear] });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, LIST)).toBe('Sear 6819 (+1)');
  });

  it('shows a single reference on its own', () => {
    const coin = makeCoin({ catalogRefs: [sear] });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, LIST)).toBe('Sear 6819');
  });

  it('shows the ordinary dash when the coin has no reference', () => {
    expect(formatInventoryCell(makeCoin(), 'catalogReference', undefined, LIST)).toBe('—');
    expect(formatInventoryCell(makeCoin({ catalogRefs: [] }), 'catalogReference', undefined, LIST)).toBe('—');
  });

  it('shows the number alone when no catalogue list was passed in', () => {
    const coin = makeCoin({ catalogRefs: [sear] });
    expect(formatInventoryCell(coin, 'catalogReference')).toBe('6819');
  });

  it('still names a removed (inactive) catalogue', () => {
    const removed: CatalogOption[] = [{ catalogId: 1, name: 'Sear', sortOrder: 1, isActive: false }];
    const coin = makeCoin({ catalogRefs: [sear] });
    expect(formatInventoryCell(coin, 'catalogReference', undefined, removed)).toBe('Sear 6819');
  });

  it('leaves every other column untouched when a catalogue list is supplied', () => {
    const coin = makeCoin({ coinType: 'Shekel', grade: 'VF', catalogRefs: [sear] });
    for (const column of inventoryColumnOrder) {
      if (column === 'catalogReference') continue;
      expect(formatInventoryCell(coin, column, undefined, LIST))
        .toBe(formatInventoryCell(coin, column));
    }
  });
});
