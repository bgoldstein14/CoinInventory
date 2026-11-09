/*
 * Filtering the grid by collection status, and finding a coin by where it is
 * stored.
 *
 * These tests go straight at the store rather than through the App shell:
 * InventoryFilterStore reads exactly one thing off InventoryService — the
 * `inventory` signal — so a two-line stub is a complete and honest test
 * double, and the result runs under Node with no DOM.
 *
 * WHAT IS BEING GUARDED
 * Being able to SEE the want list is the half of this feature that makes the
 * other half safe. The totals exclude coins the owner does not have; without
 * a way to filter the grid down to exactly those coins, "my collection is
 * worth less than I thought" and "I have forty coins on a want list" would
 * be indistinguishable.
 *
 * The other thing pinned here is the "no filter" case. A status filter that
 * accidentally hid unstatused coins would hide every coin saved before the
 * field existed — which is the whole collection.
 */

import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { InventoryFilterStore } from './inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';

function makeCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: crypto.randomUUID(), denomination: 'Dollar', year: '1881', coinType: 'Morgan',
    category: 'Silver', country: 'United States', grade: 'MS63', certCompany: '',
    certNumber: '', variety: '', mintMark: 'S', composition: '',
    purchaseDate: '2024-01-01', purchasePrice: 100, currentValue: 150, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

/**
 * The only thing InventoryFilterStore touches on InventoryService. Building a
 * real one would drag in HttpClient, IndexedDB and the spot-price machinery
 * for no gain.
 */
function storeOver(coins: CoinRecord[]): InventoryFilterStore {
  return new InventoryFilterStore({ inventory: signal(coins) } as unknown as InventoryService);
}

describe('the status filter', () => {
  const coins = [
    makeCoin({ coinType: 'Morgan', collectionStatus: 'owned' }),
    makeCoin({ coinType: 'Draped Bust', collectionStatus: 'wanted' }),
    makeCoin({ coinType: 'Peace', collectionStatus: 'for-sale' }),
    makeCoin({ coinType: 'Trade', collectionStatus: 'sold' }),
    // A coin saved before the status field existed: no status key at all.
    makeCoin({ coinType: 'Seated' })
  ];

  it('shows everything when no status is chosen', () => {
    const store = storeOver(coins);
    expect(store.collectionStatusFilter()).toBe('');
    expect(store.filteredInventory()).toHaveLength(5);
  });

  it('narrows to just the want list', () => {
    const store = storeOver(coins);
    store.collectionStatusFilter.set('wanted');

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Draped Bust']);
  });

  it('narrows to the coins being sold', () => {
    const store = storeOver(coins);
    store.collectionStatusFilter.set('for-sale');

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Peace']);
  });

  it('counts a coin with NO stored status as Owned', () => {
    // Every coin saved before the field existed arrives this way. Filtering
    // to "Owned" and getting back only the newer ones would make the owner
    // think he had lost the rest.
    const store = storeOver(coins);
    store.collectionStatusFilter.set('owned');

    expect(store.filteredInventory().map(c => c.coinType).sort()).toEqual(['Morgan', 'Seated']);
  });

  it('never hides an unstatused coin behind any other filter', () => {
    // Belt and braces for the case above: with the status filter OFF, a
    // statusless coin must come through untouched.
    const store = storeOver([makeCoin({ coinType: 'Seated' })]);
    expect(store.filteredInventory()).toHaveLength(1);
  });

  it('combines with the other filters rather than replacing them', () => {
    const store = storeOver([
      makeCoin({ coinType: 'Morgan', collectionStatus: 'wanted', country: 'United States' }),
      makeCoin({ coinType: 'Sovereign', collectionStatus: 'wanted', country: 'Great Britain' })
    ]);
    store.collectionStatusFilter.set('wanted');
    store.countryFilter.set('Great Britain');

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Sovereign']);
  });
});

describe('searching for a coin by where it is stored', () => {
  it('finds a coin by its storage location', () => {
    // "Which coins are in the safe deposit box?" is the question the field
    // exists to answer, and the search box is where the user will ask it.
    const store = storeOver([
      makeCoin({ coinType: 'Morgan', storageLocation: 'Safe deposit box 2' }),
      makeCoin({ coinType: 'Peace', storageLocation: 'Dansco 7070, page 4' })
    ]);
    store.searchQuery.set('safe deposit');

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Morgan']);
  });

  it('does not blow up on a coin with no storage location', () => {
    // A `.toLowerCase()` on undefined would throw inside a computed and
    // take the whole grid down.
    const store = storeOver([makeCoin({ coinType: 'Morgan' })]);
    store.searchQuery.set('morgan');

    expect(store.filteredInventory()).toHaveLength(1);
  });
});
