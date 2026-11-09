/*
 * Searching for a catalogue reference.
 *
 * WHY THIS MATTERS MORE THAN AN ORDINARY SEARCH FIELD
 *   For an ancient coin the catalogue reference is frequently the ONLY thing
 *   that identifies it: no year, no denomination, no grade, and a coin type
 *   that is a guess. "Sear 6819" is how the owner finds that coin, so a
 *   catalogue column the grid can display but the search box cannot find
 *   would miss the entire point of adding the field.
 *
 *   The specific trap is that the grid composes the displayed string from a
 *   foreign key plus a number. If the search builds its own version of that
 *   string, the two drift: the grid shows "Sear 6819", the user types exactly
 *   what he sees, and nothing comes back. Both go through
 *   coinCatalogReference(), and these tests are what hold that true.
 *
 *   The `?? ''` trap from the storage-location field applies here too: a
 *   coin saved before these fields existed has neither, and `undefined`
 *   joined into the haystack puts the literal word "undefined" in it, so a
 *   search for "undefined" returns the whole collection.
 */

import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { InventoryFilterStore } from './inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CatalogOption } from '../../types/catalog-reference';

const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true }
];

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: crypto.randomUUID(), denomination: '', year: '', coinType: '',
    category: '', country: '', grade: '', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

function storeOver(coins: CoinRecord[], catalogs: CatalogOption[] = CATALOGS): InventoryFilterStore {
  return new InventoryFilterStore({
    inventory: signal(coins),
    catalogs: signal(catalogs)
  } as unknown as InventoryService);
}

const coins = [
  makeCoin({ coinType: 'Bar Kochba', catalogId: 3, catalogNumber: '736' }),
  makeCoin({ coinType: 'Byzantine follis', catalogId: 1, catalogNumber: '6819' }),
  // A reference that arrived from an import: a number, no catalogue resolved.
  makeCoin({ coinType: 'Unattributed', catalogNumber: '44/5' }),
  // The ordinary modern coin: no catalogue reference at all.
  makeCoin({ coinType: 'Morgan', denomination: '$1', year: '1881' })
];

describe('searching by catalogue reference', () => {
  it('finds a coin by the whole reference as the grid shows it', () => {
    const store = storeOver(coins);
    store.searchQuery.set('sear 6819');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('finds a coin by the catalogue name alone', () => {
    const store = storeOver(coins);
    store.searchQuery.set('hendin');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Bar Kochba']);
  });

  it('finds a coin by the number alone', () => {
    const store = storeOver(coins);
    store.searchQuery.set('736');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Bar Kochba']);
  });

  it('finds an imported coin whose catalogue was never resolved', () => {
    const store = storeOver(coins);
    store.searchQuery.set('44/5');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Unattributed']);
  });

  it('does not put the word "undefined" into the haystack', () => {
    // The Morgan has neither field. If either were joined in raw, searching
    // for "undefined" would return the entire collection.
    const store = storeOver(coins);
    store.searchQuery.set('undefined');
    expect(store.filteredInventory()).toEqual([]);
  });

  it('still works when the catalogue list has not loaded yet', () => {
    // Hydration is two phases: coins arrive first, lookups afterwards, and a
    // lookup is allowed to fail outright without breaking the app. The number
    // must remain searchable in the meantime.
    const store = storeOver(coins, []);
    store.searchQuery.set('6819');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('leaves searches that have nothing to do with catalogues alone', () => {
    const store = storeOver(coins);
    store.searchQuery.set('morgan');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Morgan']);
  });
});
