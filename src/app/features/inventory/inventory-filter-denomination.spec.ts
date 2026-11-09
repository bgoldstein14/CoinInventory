/*
 * Searching for a denomination.
 *
 * THE FAILURE THESE TESTS PREVENT
 *   A coin visible in the grid as `8 Reales` that the search box can only
 *   find under `Pillar Dollar`. The user types what he can see, nothing
 *   comes back, and he concludes the coin is gone. Same shape as the
 *   catalogue reference (inventory-filter-catalog.spec.ts): the string on
 *   screen is derived from an id, not read out of a column.
 *
 * WHY THE HAYSTACK CARRIES BOTH THE LABEL AND THE RECORDED TEXT
 *   They can differ, and after an import they usually do: the column keeps
 *   saying `Pillar Dollar` while the id says `8 Reales`.
 *
 *     THE LABEL, because it is what the grid shows. Without it a resolved
 *     coin is visible and unfindable.
 *
 *     THE TEXT, because it is the original wording and the artefact a
 *     migration review reads; dropping it would be a REGRESSION. Adding the
 *     label is strictly additive: it can never make a visible coin
 *     unfindable.
 *
 *   For an unresolved coin the two coincide — the text is inside the string
 *   on screen — so there is nothing to choose between.
 */

import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { InventoryFilterStore } from './inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord, Denomination } from '../../types/coin.model';
import {
  DENOMINATION_LOOKUP,
  MEXICO_8_REALES,
  US_DOLLAR
} from '../../testing/denomination-lookup.fixture';

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

function storeOver(
  coins: CoinRecord[],
  denominations: readonly Denomination[] = DENOMINATION_LOOKUP
): InventoryFilterStore {
  return new InventoryFilterStore({
    inventory: signal(coins),
    denominations: signal(denominations)
  } as unknown as InventoryService);
}

/** A coin whose id and text disagree — the ordinary post-import state. */
const RESOLVED_DIVERGENT = makeCoin({
  coinType: 'Pillar', denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar'
});

/** No id, and nothing in the lookup names it. Reads as unresolved on screen. */
const UNRESOLVED = makeCoin({ coinType: 'Trade', denomination: 'Trade Dollar' });

/** No id, but its text resolves — the state of a coin that has no id yet. */
const RESOLVES_BY_TEXT = makeCoin({
  coinType: 'Three Cent', denomination: 'Trime', country: 'United States'
});

const COINS = [RESOLVED_DIVERGENT, UNRESOLVED, RESOLVES_BY_TEXT];

function found(query: string, coins: CoinRecord[] = COINS): string[] {
  const store = storeOver(coins);
  store.searchQuery.set(query);
  return store.filteredInventory().map(coin => coin.coinType);
}

describe('searching by what the grid actually shows', () => {
  it('finds a coin by the Label its id resolves to', () => {
    // The grid prints '8 Reales'; the column still says 'Pillar Dollar'.
    expect(found('8 reales')).toEqual(['Pillar']);
  });

  it('finds an id-less coin by the Label its TEXT resolves to', () => {
    // The column says 'Trime'; the lookup row — and therefore the grid —
    // say '3CS'. This is the state of every coin that has no id yet.
    expect(found('3cs')).toEqual(['Three Cent']);
  });

  it('finds an unresolved coin by the text inside the string on screen', () => {
    expect(found('trade dollar')).toEqual(['Trade']);
  });

  it('finds every unresolved coin by the word the grid labels them with', () => {
    // Typing what is on screen is the whole contract, and the unresolved
    // form is on screen. Exactly one of these three coins names nothing the
    // lookup knows, so exactly one comes back.
    expect(found('other (')).toEqual(['Trade']);
  });
});

describe('searching by what the source recorded', () => {
  it('still finds a resolved coin by the text it was imported with', () => {
    // NOT a nice-to-have: the recorded text is the artefact a migration
    // review reads, and losing it would be a regression.
    expect(found('pillar dollar')).toEqual(['Pillar']);
  });

  it('still finds an id-less coin by the spelling in its column', () => {
    expect(found('trime')).toEqual(['Three Cent']);
  });
});

describe('the un-migrated and un-hydrated states', () => {
  it('searches the plain text when no lookup has arrived', () => {
    // The store is built with a two-line service stub in several specs, and
    // phase 2 of hydration is allowed to fail. Neither may take the search
    // box down, and neither may change what it matches.
    const coins = [makeCoin({ coinType: 'Morgan', denomination: '$1' })];
    const store = storeOver(coins, []);
    store.searchQuery.set('$1');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Morgan']);
  });

  it('survives a service with no denominations signal at all', () => {
    const store = new InventoryFilterStore({
      inventory: signal([makeCoin({ coinType: 'Morgan', denomination: '$1' })])
    } as unknown as InventoryService);
    store.searchQuery.set('morgan');
    expect(store.filteredInventory()).toHaveLength(1);
  });

  it('matches the same coins before and after an id is written', () => {
    // Writing an id must not change what the search box finds, in either
    // direction. Same coin, same text, id absent and id present.
    const before = [makeCoin({ coinType: 'Dollar', denomination: '$1' })];
    const after = [makeCoin({ coinType: 'Dollar', denominationId: US_DOLLAR, denomination: '$1' })];
    expect(found('$1', before)).toEqual(['Dollar']);
    expect(found('$1', after)).toEqual(['Dollar']);
  });
});

describe('nothing leaks into the haystack', () => {
  it('puts no placeholder or undefined in it for a coin with no denomination', () => {
    // The em-dash a blank cell renders is NOT searchable text — a search for
    // it would return every unrecorded coin in the collection, which is not
    // a question anyone is asking. Same trap as the literal 'undefined' the
    // storage-location field had to be defended from.
    const blank = [makeCoin({ coinType: 'Mystery', denomination: '' })];
    expect(found('—', blank)).toEqual([]);
    expect(found('undefined', blank)).toEqual([]);
    expect(found('null', blank)).toEqual([]);
  });
});
