/*
 * InventoryFilterStore: status filtering and the search haystack.
 *
 * Two coin factories, not interchangeable: `makeCoin` is a populated Morgan
 * dollar for the status tests; `makeBlankCoin` leaves every text field empty
 * so the "nothing leaks into the haystack" assertions are meaningful.
 *
 * Built without a StorageService, so no fake-indexeddb import is needed.
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

/** Blank by default, so haystack assertions aren't satisfied by fixture text. */
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

// Guards makeBlankCoin: if it gained populated defaults, the haystack tests
// below would still pass while testing nothing.
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

/** Minimal InventoryService stub: the store only reads `inventory` here. */
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

/* ---- Status filter and storage-location search ---- */

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
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['owned', 'for-sale']);

    expect(store.filteredInventory().map(c => c.coinType).sort())
      .toEqual(['Morgan', 'Peace', 'Seated']);
  });

  it('shows NOTHING when no status is ticked', () => {
    // Deliberate: an empty set is not treated as "show everything".
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
    // Coins saved before the status field existed must count as Owned.
    const store = storeOver(coins);
    store.collectionStatusFilter.set(['owned']);

    expect(store.filteredInventory().map(c => c.coinType).sort()).toEqual(['Morgan', 'Seated']);
  });

  it('never hides an unstatused coin while everything is ticked', () => {
    // A statusless coin normalises to Owned, which is ticked by default.
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
    const store = storeOver([
      makeCoin({ coinType: 'Morgan', storageLocation: 'Safe deposit box 2' }),
      makeCoin({ coinType: 'Peace', storageLocation: 'Dansco 7070, page 4' })
    ]);
    store.searchQuery.set('safe deposit');

    expect(store.filteredInventory().map(c => c.coinType)).toEqual(['Morgan']);
  });

  it('does not blow up on a coin with no storage location', () => {
    // `.toLowerCase()` on undefined would throw inside the computed.
    const store = storeOver([makeCoin({ coinType: 'Morgan' })]);
    store.searchQuery.set('morgan');

    expect(store.filteredInventory()).toHaveLength(1);
  });
});

/*
 * ---- Catalogue reference search ----
 * The search must match the string the grid shows (both use
 * coinCatalogReference()), and missing fields must not add "undefined".
 */

const catalogCoins = [
  makeBlankCoin({ coinType: 'Bar Kochba', catalogRefs: [{ catalogId: 3, catalogNumber: '736' }] }),
  makeBlankCoin({ coinType: 'Byzantine follis', catalogRefs: [{ catalogId: 1, catalogNumber: '6819' }, { catalogId: null, catalogNumber: 'Cohen 45' }] }),
  // A reference that arrived from an import: a number, no catalogue resolved.
  makeBlankCoin({ coinType: 'Unattributed', catalogRefs: [{ catalogId: null, catalogNumber: '44/5' }] }),
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
    // Lookups hydrate after coins and may fail; the number stays searchable.
    const store = storeWithCatalogs(catalogCoins, []);
    store.searchQuery.set('6819');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('finds a coin by a reference that is not its main one', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('cohen 45');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Byzantine follis']);
  });

  it('sorts by the main reference', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('');
    store.sortState.set({ column: 'catalogReference', direction: 'asc' });
    // Hendin 736, Sear 6819 (+1), then the number-only 44/5 sorts first as text; Morgan has none.
    const order = store.filteredInventory().map(coin => coin.coinType);
    expect(order.indexOf('Bar Kochba')).toBeLessThan(order.indexOf('Byzantine follis'));
    store.sortState.set({ column: 'catalogReference', direction: 'desc' });
    const reversed = store.filteredInventory().map(coin => coin.coinType);
    expect(reversed.indexOf('Byzantine follis')).toBeLessThan(reversed.indexOf('Bar Kochba'));
  });

  it('leaves searches that have nothing to do with catalogues alone', () => {
    const store = storeWithCatalogs(catalogCoins);
    store.searchQuery.set('morgan');
    expect(store.filteredInventory().map(coin => coin.coinType)).toEqual(['Morgan']);
  });
});

/*
 * ---- Denomination search ----
 * The haystack holds both the resolved label (what the grid shows) and the
 * recorded text (what the source said); after an import they often differ.
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
    // Column says 'Trime'; the lookup (and the grid) say '3CS'.
    expect(found('3cs')).toEqual(['Three Cent']);
  });

  it('finds an unresolved coin by the text inside the string on screen', () => {
    expect(found('trade dollar')).toEqual(['Trade']);
  });

  it('finds every unresolved coin by the word the grid labels them with', () => {
    // Only one of the three coins is unresolved, so only it matches.
    expect(found('other (')).toEqual(['Trade']);
  });
});

describe('searching by what the source recorded', () => {
  it('still finds a resolved coin by the text it was imported with', () => {
    expect(found('pillar dollar')).toEqual(['Pillar']);
  });

  it('still finds an id-less coin by the spelling in its column', () => {
    expect(found('trime')).toEqual(['Three Cent']);
  });
});

describe('the un-migrated and un-hydrated states', () => {
  it('searches the plain text when no lookup has arrived', () => {
    // Stubbed services and failed hydration must not change what is matched.
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
    // The em-dash placeholder is not searchable text.
    const blank = [makeBlankCoin({ coinType: 'Mystery', denomination: '' })];
    expect(found('—', blank)).toEqual([]);
    expect(found('undefined', blank)).toEqual([]);
    expect(found('null', blank)).toEqual([]);
  });
});
