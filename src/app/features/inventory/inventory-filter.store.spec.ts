/*
 * InventoryFilterStore — status filtering and the search haystack.
 *
 * MERGED FILE. Three specs were folded in here, each keeping the header it
 * arrived with as a banner above its own block:
 *   inventory-filter-status.spec.ts       -> 'the status filter',
 *                                            'searching for a coin by where
 *                                             it is stored'
 *   inventory-filter-catalog.spec.ts      -> 'searching by catalogue reference'
 *   inventory-filter-denomination.spec.ts -> 'searching by what the grid
 *                                             actually shows' and the three
 *                                             blocks after it
 *
 * TWO COIN FACTORIES, AND THEY ARE NOT INTERCHANGEABLE.
 *   `makeCoin` defaults to a populated Morgan dollar and belongs to the
 *   status block, which needs coins that look like coins.
 *   `makeBlankCoin` defaults every field to an empty string and belongs to
 *   the catalogue and denomination blocks, whose whole point is that nothing
 *   leaks into the search haystack. Those assertions are only meaningful
 *   while every other field is blank: hand one of them a populated coin and
 *   it still passes while testing nothing. Do not merge the two.
 *
 * These tests build InventoryFilterStore with no StorageService, so there is
 * deliberately no `import 'fake-indexeddb/auto'` here — they must keep
 * running without an ambient indexedDB.
 */

import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { InventoryFilterStore } from './inventory-filter.store';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord, Denomination } from '../../types/coin.model';
import { CatalogOption } from '../../types/catalog-reference';
import {
  DENOMINATION_LOOKUP,
  MEXICO_8_REALES,
  US_DOLLAR
} from '../../testing/denomination-lookup.fixture';

/** Populated by default. For the status block. */
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
 * Blank by default. For the catalogue and denomination blocks, where a coin
 * carrying any other text would make the "nothing leaks into the haystack"
 * assertions vacuous.
 */
function makeBlankCoin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: crypto.randomUUID(), denomination: '', year: '', coinType: '',
    category: '', country: '', grade: '', certCompany: '',
    certNumber: '', variety: '', mintMark: '', composition: '',
    purchaseDate: '', purchasePrice: 0, currentValue: 0, notes: '',
    imagePaths: [], source: 'manual', hasCacSticker: false,
    ...overrides
  } as CoinRecord;
}

/*
 * ANTI-VACUITY GUARD FOR THE TWO FACTORIES ABOVE.
 *
 * This file was merged from three, each of which had its own `makeCoin`.
 * Two of them defaulted to blank and one to a populated Morgan dollar, and
 * the obvious tidy-up — folding them into a single factory — silently
 * destroys the catalogue and denomination blocks: every "nothing leaks into
 * the haystack" assertion keeps passing while testing nothing, because the
 * leak it looks for is now supplied by the fixture itself.
 *
 * That was MEASURED, not guessed: swapping makeBlankCoin's defaults for the
 * populated ones left all 28 tests in this file green. Nothing else here can
 * see the mistake, so this is the thing that does.
 */
describe('the blank fixture really is blank', () => {
  it('leaves every searchable text field empty, or the haystack tests are vacuous', () => {
    const blank = makeBlankCoin();

    for (const field of [
      'denomination', 'year', 'coinType', 'category', 'country', 'grade',
      'certCompany', 'certNumber', 'variety', 'mintMark', 'composition', 'notes'
    ] as const) {
      expect(blank[field], `makeBlankCoin().${field} must be empty`).toBe('');
    }
  });
});

/**
 * The only thing InventoryFilterStore touches on InventoryService. Building a
 * real one would drag in HttpClient, IndexedDB and the spot-price machinery
 * for no gain.
 */
function storeOver(coins: CoinRecord[]): InventoryFilterStore {
  return new InventoryFilterStore({ inventory: signal(coins) } as unknown as InventoryService);
}

const CATALOGS: CatalogOption[] = [
  { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
  { catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true }
];

function storeWithCatalogs(
  coins: CoinRecord[],
  catalogs: CatalogOption[] = CATALOGS
): InventoryFilterStore {
  return new InventoryFilterStore({
    inventory: signal(coins),
    catalogs: signal(catalogs)
  } as unknown as InventoryService);
}

function storeWithDenominations(
  coins: CoinRecord[],
  denominations: readonly Denomination[] = DENOMINATION_LOOKUP
): InventoryFilterStore {
  return new InventoryFilterStore({
    inventory: signal(coins),
    denominations: signal(denominations)
  } as unknown as InventoryService);
}

/*
 * ---------------------------------------------------------------------------
 * From inventory-filter-status.spec.ts:
 *
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
 * ---------------------------------------------------------------------------
 */

describe('the status filter', () => {
  const coins = [
    makeCoin({ coinType: 'Morgan', collectionStatus: 'owned' }),
    makeCoin({ coinType: 'Draped Bust', collectionStatus: 'wanted' }),
    makeCoin({ coinType: 'Peace', collectionStatus: 'for-sale' }),
    makeCoin({ coinType: 'Trade', collectionStatus: 'sold' }),
    // A coin saved before the status field existed: no status key at all.
    makeCoin({ coinType: 'Seated' })
  ];

  it('starts with every status ticked, so everything is shown', () => {
    /* The filter is a SET now, not a single choice with an "All statuses"
     * option on top. All five ticked IS what that option used to mean, so
     * the option had nothing left to say and was removed. */
    const store = storeOver(coins);
    expect([...store.collectionStatusFilter()])
      .toEqual(['owned', 'wanted', 'ordered', 'for-sale', 'sold']);
    expect(store.filteredInventory()).toHaveLength(5);
  });

  it('narrows to just the want list', () => {
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['wanted']);

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Draped Bust']);
  });

  it('narrows to the coins being sold', () => {
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['for-sale']);

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Peace']);
  });

  it('shows SEVERAL statuses at once, which the dropdown could not', () => {
    /* The reason for the change. "What I own and what is up for sale, but
     * not the want list" is an ordinary question and it was unaskable: the
     * old control offered one status or all of them and nothing between. */
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['owned', 'for-sale']);

    expect(store.filteredInventory().map(c => c.coinType).sort())
      .toEqual(['Morgan', 'Peace', 'Seated']);
  });

  it('shows NOTHING when no status is ticked', () => {
    /* DELIBERATE, and the alternative was considered. Reading an empty set
     * as "show everything" would make all-ticked and none-ticked mean the
     * same thing -- which is precisely the redundancy that removing the
     * "All statuses" option got rid of, put back one layer down. Each box
     * says "include this status"; include none and nothing is included.
     * The filter bar prints a line saying so next to the empty boxes. */
    const store = storeOver(coins);
    store.clearCollectionStatuses();

    expect(store.filteredInventory()).toEqual([]);
  });

  it('ticks and unticks one status at a time, keeping canonical order', () => {
    const store = storeOver(coins);
    store.clearCollectionStatuses();
    store.toggleCollectionStatus('sold');
    store.toggleCollectionStatus('owned');

    // Collecting-cycle order, not click order.
    expect([...store.collectionStatusFilter()]).toEqual(['owned', 'sold']);
    expect(store.isCollectionStatusSelected('owned')).toBe(true);
    expect(store.isCollectionStatusSelected('wanted')).toBe(false);

    store.toggleCollectionStatus('owned');
    expect([...store.collectionStatusFilter()]).toEqual(['sold']);

    store.selectAllCollectionStatuses();
    expect(store.filteredInventory()).toHaveLength(5);
  });

  it('counts a coin with NO stored status as Owned', () => {
    // Every coin saved before the field existed arrives this way. Filtering
    // to "Owned" and getting back only the newer ones would make the owner
    // think he had lost the rest.
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['owned']);

    expect(store.filteredInventory().map(c => c.coinType).sort()).toEqual(['Morgan', 'Seated']);
  });

  it('never hides an unstatused coin while everything is ticked', () => {
    /* The safety property of the whole feature, restated for the set.
     * A statusless coin normalises to Owned, Owned is ticked by default,
     * so the entire pre-migration-010 collection is visible on first load.
     * Get this wrong and the owner opens the app to an empty grid. */
    const store = storeOver([makeCoin({ coinType: 'Seated' })]);
    expect(store.filteredInventory()).toHaveLength(1);
  });

  it('combines with the other filters rather than replacing them', () => {
    const store = storeOver([
      makeCoin({ coinType: 'Morgan', collectionStatus: 'wanted', country: 'United States' }),
      makeCoin({ coinType: 'Sovereign', collectionStatus: 'wanted', country: 'Great Britain' })
    ]);
    store.collectionStatusFilter.set(['wanted']);
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

/*
 * ---------------------------------------------------------------------------
 * From inventory-filter-catalog.spec.ts:
 *
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
 * ---------------------------------------------------------------------------
 */

const catalogCoins = [
  makeBlankCoin({ coinType: 'Bar Kochba', catalogId: 3, catalogNumber: '736' }),
  makeBlankCoin({ coinType: 'Byzantine follis', catalogId: 1, catalogNumber: '6819' }),
  // A reference that arrived from an import: a number, no catalogue resolved.
  makeBlankCoin({ coinType: 'Unattributed', catalogNumber: '44/5' }),
  // The ordinary modern coin: no catalogue reference at all.
  makeBlankCoin({ coinType: 'Morgan', denomination: '$1', year: '1881' })
];

describe('searching by catalogue reference', () => {
  it('finds a coin by the whole reference as the grid shows it', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('sear 6819');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('finds a coin by the catalogue name alone', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('hendin');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Bar Kochba']);
  });

  it('finds a coin by the number alone', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('736');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Bar Kochba']);
  });

  it('finds an imported coin whose catalogue was never resolved', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('44/5');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Unattributed']);
  });

  it('does not put the word "undefined" into the haystack', () => {
    // The Morgan has neither field. If either were joined in raw, searching
    // for "undefined" would return the entire collection.
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('undefined');
    expect(store.filteredInventory()).toEqual([]);
  });

  it('still works when the catalogue list has not loaded yet', () => {
    // Hydration is two phases: coins arrive first, lookups afterwards, and a
    // lookup is allowed to fail outright without breaking the app. The number
    // must remain searchable in the meantime.
    const store = storeWithCatalogs(catalogCoins, []);
    store.searchQuery.set('6819');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('leaves searches that have nothing to do with catalogues alone', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('morgan');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Morgan']);
  });
});

/*
 * ---------------------------------------------------------------------------
 * From inventory-filter-denomination.spec.ts — the four blocks below:
 *
 * Searching for a denomination.
 *
 * THE FAILURE THESE TESTS PREVENT
 *   A coin visible in the grid as `8 Reales` that the search box can only
 *   find under `Pillar Dollar`. The user types what he can see, nothing
 *   comes back, and he concludes the coin is gone. Same shape as the
 *   catalogue reference (the 'searching by catalogue reference' block
 *   above): the string on screen is derived from an id, not read out of a
 *   column.
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
 * ---------------------------------------------------------------------------
 */

/** A coin whose id and text disagree — the ordinary post-import state. */
const RESOLVED_DIVERGENT = makeBlankCoin({
  coinType: 'Pillar', denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar'
});

/** No id, and nothing in the lookup names it. Reads as unresolved on screen. */
const UNRESOLVED = makeBlankCoin({ coinType: 'Trade', denomination: 'Trade Dollar' });

/** No id, but its text resolves — the state of a coin that has no id yet. */
const RESOLVES_BY_TEXT = makeBlankCoin({
  coinType: 'Three Cent', denomination: 'Trime', country: 'United States'
});

const COINS = [RESOLVED_DIVERGENT, UNRESOLVED, RESOLVES_BY_TEXT];

function found(query: string, coins: CoinRecord[] = COINS): string[] {
  const store = storeWithDenominations(coins);
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
    const coins = [makeBlankCoin({ coinType: 'Morgan', denomination: '$1' })];
    const store = storeWithDenominations(coins, []);
    store.searchQuery.set('$1');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Morgan']);
  });

  it('survives a service with no denominations signal at all', () => {
    const store = new InventoryFilterStore({
      inventory: signal([makeBlankCoin({ coinType: 'Morgan', denomination: '$1' })])
    } as unknown as InventoryService);
    store.searchQuery.set('morgan');
    expect(store.filteredInventory()).toHaveLength(1);
  });

  it('matches the same coins before and after an id is written', () => {
    // Writing an id must not change what the search box finds, in either
    // direction. Same coin, same text, id absent and id present.
    const before = [makeBlankCoin({ coinType: 'Dollar', denomination: '$1' })];
    const after = [
      makeBlankCoin({ coinType: 'Dollar', denominationId: US_DOLLAR, denomination: '$1' })
    ];
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
    const blank = [makeBlankCoin({ coinType: 'Mystery', denomination: '' })];
    expect(found('—', blank)).toEqual([]);
    expect(found('undefined', blank)).toEqual([]);
    expect(found('null', blank)).toEqual([]);
  });
});
