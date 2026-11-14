/*
 * The rules for folding the main grid into groups.
 *
 * Everything under test here is pure, which is the point: the suite runs
 * under Node with no jsdom, so a grouping rule decided inside a template
 * could not be tested at all.
 */
import { describe, expect, it } from 'vitest';
import { CoinRecord } from '../../types/coin.model';
import { inventoryColumnOrder } from '../../types/inventory-columns';
import {
  DEFAULT_GROUPING,
  GROUPING_COLUMN_KINDS,
  GROUPING_OPTIONS,
  GroupExpansion,
  applyExpandAllControl,
  buildCoinGroups,
  collapseAllGroups,
  describeExpandAllControl,
  emptyGroupLabel,
  expandAllGroups,
  flatGridRows,
  groupKeyFor,
  groupedGridRows,
  isGroupExpanded,
  isGroupableColumn,
  renderedCoins,
  restoreGrouping,
  serializeGrouping,
  toggleGroup
} from './grid-grouping';

function coin(overrides: Partial<CoinRecord> = {}): CoinRecord {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    coinType: '',
    denomination: '',
    country: '',
    year: '',
    grade: '',
    mintMark: '',
    variety: '',
    certCompany: '',
    certNumber: '',
    notes: '',
    purchasePrice: 0,
    currentValue: 0,
    ...overrides
  } as CoinRecord;
}

const labels = (groups: ReadonlyArray<{ label: string }>) => groups.map(group => group.label);

describe('which columns may be grouped by', () => {
  it('refuses every numeric column — one group per price is the flat grid with headings wasted on it', () => {
    for (const column of ['purchasePrice', 'currentValue', 'meltValue', 'soldPrice',
      'weight', 'pmWeightGrams', 'pmPercent'] as const) {
      expect(isGroupableColumn(column)).toBe(false);
      expect(GROUPING_COLUMN_KINDS[column]).toBe('numeric');
    }
  });

  it('offers the text columns a collector would actually group by', () => {
    for (const column of ['country', 'year', 'denomination', 'grade', 'category',
      'collectionStatus', 'coinSet', 'storageLocation', 'metalContent'] as const) {
      expect(isGroupableColumn(column)).toBe(true);
    }
  });

  it('refuses a column that no longer exists at all', () => {
    // `Source` was dropped from the grid; a saved grouping naming it must
    // not get through this gate.
    expect(isGroupableColumn('source')).toBe(false);
    expect(isGroupableColumn('')).toBe(false);
    expect(isGroupableColumn(null)).toBe(false);
    expect(isGroupableColumn(undefined)).toBe(false);
  });

  it('has a declared kind for every column in the grid', () => {
    // The Record is exhaustive at compile time; this is the runtime half,
    // so the next money column cannot slip into the menu by accident.
    for (const column of inventoryColumnOrder) {
      expect(GROUPING_COLUMN_KINDS[column]).toBeDefined();
    }
  });

  it('lists the menu in canonical column order and offers no numeric one', () => {
    const offered = GROUPING_OPTIONS.map(option => option.column);
    expect(offered).toEqual(inventoryColumnOrder.filter(isGroupableColumn));
    expect(offered).not.toContain('currentValue');
    expect(offered).toContain('country');
  });

  it('spells out the headers that are abbreviated in the grid', () => {
    const denomination = GROUPING_OPTIONS.find(option => option.column === 'denomination');
    expect(denomination?.label).toBe('Denomination');
    expect(emptyGroupLabel('denomination')).toBe('(No Denomination)');
  });
});

describe('nothing selected is exactly the flat grid', () => {
  it('draws one coin row per coin, in order, with no headings', () => {
    const coins = [coin({ id: 'a' }), coin({ id: 'b' }), coin({ id: 'c' })];
    const rows = flatGridRows(coins);

    expect(rows.map(row => row.kind)).toEqual(['coin', 'coin', 'coin']);
    expect(renderedCoins(rows).map(c => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('is not a grouping of one', () => {
    expect(flatGridRows([coin({ id: 'a' })]).some(row => row.kind === 'group')).toBe(false);
  });

  it('is what a fresh install starts as', () => {
    expect(DEFAULT_GROUPING.column).toBeNull();
  });
});

describe('bucketing rows', () => {
  const coins = [
    coin({ id: '1', country: 'Mexico', currentValue: 10 }),
    coin({ id: '2', country: 'France', currentValue: 20 }),
    coin({ id: '3', country: 'Mexico', currentValue: 30 }),
    coin({ id: '4', country: '', currentValue: 40 })
  ];

  it('counts each group', () => {
    const groups = buildCoinGroups(coins, 'country');
    const mexico = groups.find(group => group.label === 'Mexico');
    expect(mexico?.count).toBe(2);
    expect(mexico?.coins.map(c => c.id)).toEqual(['1', '3']);
  });

  it('names the no-value bucket so it cannot be read as a real country', () => {
    const groups = buildCoinGroups(coins, 'country');
    const bucket = groups.find(group => group.isEmptyBucket);
    expect(bucket?.label).toBe('(No Country)');
    expect(bucket?.count).toBe(1);
  });

  it('puts the no-value bucket last, whichever way the groups run', () => {
    expect(labels(buildCoinGroups(coins, 'country'))).toEqual(['France', 'Mexico', '(No Country)']);

    const descending = buildCoinGroups(coins, 'country', {
      sort: { column: 'country', direction: 'desc' }
    });
    expect(labels(descending)).toEqual(['Mexico', 'France', '(No Country)']);
  });

  it('orders the groups alphabetically, because looking a country up is the point', () => {
    const unsorted = [
      coin({ country: 'Zambia' }), coin({ country: 'Austria' }), coin({ country: 'Mexico' })
    ];
    expect(labels(buildCoinGroups(unsorted, 'country'))).toEqual(['Austria', 'Mexico', 'Zambia']);
  });

  it('keeps the rows inside a group in the order the sort put them', () => {
    // buildCoinGroups partitions; it never re-sorts. The grid is already
    // sorted by Year when it gets here, and every group stays that way.
    const byYear = [
      coin({ id: 'old', country: 'Mexico', year: '1878' }),
      coin({ id: 'mid', country: 'France', year: '1900' }),
      coin({ id: 'new', country: 'Mexico', year: '1921' })
    ];
    const mexico = buildCoinGroups(byYear, 'country').find(group => group.label === 'Mexico');
    expect(mexico?.coins.map(c => c.id)).toEqual(['old', 'new']);
  });

  it('turns the group order round only when the sort column IS the grouping column', () => {
    // Sorting by Year while grouped by Country sorts the rows inside each
    // country; it must not reverse the country list as a side effect.
    const groups = buildCoinGroups(coins, 'country', {
      sort: { column: 'year', direction: 'desc' }
    });
    expect(labels(groups)).toEqual(['France', 'Mexico', '(No Country)']);
  });

  it('groups by the FORMATTED cell, so the heading says what the column says', () => {
    const status = coin({ collectionStatus: undefined });
    // A coin with no stored status is Owned, and the heading must say so
    // rather than inventing an empty bucket the grid does not show.
    expect(groupKeyFor(status, 'collectionStatus')).toBe('Owned');
    expect(buildCoinGroups([status], 'collectionStatus')[0].isEmptyBucket).toBe(false);
  });

  it('reads the grid em-dash as "no value", not as a value', () => {
    expect(groupKeyFor(coin({ grade: '' }), 'grade')).toBeNull();
    expect(groupKeyFor(coin({ grade: 'MS65' }), 'grade')).toBe('MS65');
  });
});

describe('what a collapsed heading has to say for itself', () => {
  it('carries the count and the money, so sixty groups can be read shut', () => {
    const groups = buildCoinGroups([
      coin({ country: 'Mexico', currentValue: 10.5, collectionStatus: 'owned' }),
      coin({ country: 'Mexico', currentValue: 4.5, collectionStatus: 'owned' })
    ], 'country');

    expect(groups[0].count).toBe(2);
    expect(groups[0].heldValue).toBe(15);
    expect(groups[0].summary).toBe('2 coins · $15.00');
  });

  it('says "1 coin", not "1 coins"', () => {
    const groups = buildCoinGroups([coin({ country: 'Peru', collectionStatus: 'owned' })], 'country');
    expect(groups[0].summary).toBe('1 coin · $0.00');
  });

  it('never sums a want list into the money', () => {
    // The whole reason the total goes through sumCurrentValue: a wanted
    // coin is one the owner is dreaming about, and adding it to a heading
    // reports a collection bigger than the one in the safe.
    const groups = buildCoinGroups([
      coin({ country: 'Mexico', currentValue: 100, collectionStatus: 'owned' }),
      coin({ country: 'Mexico', currentValue: 900, collectionStatus: 'wanted' })
    ], 'country');

    expect(groups[0].count).toBe(2);
    expect(groups[0].heldValue).toBe(100);
  });
});

describe('which groups are open', () => {
  const headings = ['France', 'Mexico', '(No Country)'];

  it('starts with every group shut once a grouping is chosen', () => {
    const state = collapseAllGroups();
    for (const heading of headings) expect(isGroupExpanded(state, heading)).toBe(false);
  });

  it('shuts a group nobody has ever seen — which a set of folded headings cannot', () => {
    // Collapse all with a search running, clear the search, and the groups
    // that were off screen must still be shut. This is the whole reason the
    // state is a default plus exceptions.
    const state = collapseAllGroups();
    expect(isGroupExpanded(state, 'A country imported five minutes from now')).toBe(false);
  });

  it('opens a group a user has never seen once Expand all has been pressed', () => {
    const state = expandAllGroups();
    expect(isGroupExpanded(state, 'Somewhere new')).toBe(true);
  });

  it('toggles one group without disturbing the others', () => {
    const state = toggleGroup(collapseAllGroups(), 'Mexico');
    expect(isGroupExpanded(state, 'Mexico')).toBe(true);
    expect(isGroupExpanded(state, 'France')).toBe(false);
  });

  it('shuts an open group again', () => {
    const opened = toggleGroup(collapseAllGroups(), 'Mexico');
    expect(isGroupExpanded(toggleGroup(opened, 'Mexico'), 'Mexico')).toBe(false);
  });
});

describe('the one expand/collapse control', () => {
  const headings = ['France', 'Mexico'];

  it('offers Expand all when everything is shut', () => {
    expect(describeExpandAllControl(collapseAllGroups(), headings).action).toBe('expand');
    expect(describeExpandAllControl(collapseAllGroups(), headings).label).toBe('Expand all');
  });

  it('offers Collapse all when ANY group is open, not most of them', () => {
    const oneOpen = toggleGroup(collapseAllGroups(), 'Mexico');
    expect(describeExpandAllControl(oneOpen, headings).action).toBe('collapse');
  });

  it('actually collapses everything, including the exceptions', () => {
    const messy: GroupExpansion = { collapsedByDefault: false, exceptions: new Set(['France']) };
    const collapsed = applyExpandAllControl('collapse');
    expect(describeExpandAllControl(messy, headings).action).toBe('collapse');
    for (const heading of [...headings, 'Never seen']) {
      expect(isGroupExpanded(collapsed, heading)).toBe(false);
    }
  });

  it('actually expands everything', () => {
    const expanded = applyExpandAllControl('expand');
    for (const heading of headings) expect(isGroupExpanded(expanded, heading)).toBe(true);
  });

  it('counts the groups in what it says out loud', () => {
    expect(describeExpandAllControl(collapseAllGroups(), headings).ariaLabel)
      .toBe('Expand all 2 group(s)');
  });
});

describe('what the table draws', () => {
  const coins = [
    coin({ id: 'fr-1', country: 'France' }),
    coin({ id: 'mx-1', country: 'Mexico' }),
    coin({ id: 'mx-2', country: 'Mexico' })
  ];
  const groups = buildCoinGroups(coins, 'country');

  it('draws headings only while everything is collapsed', () => {
    const rows = groupedGridRows(groups, collapseAllGroups());
    expect(rows.map(row => row.kind)).toEqual(['group', 'group']);
    expect(renderedCoins(rows)).toEqual([]);
  });

  it('draws the rows of the one group the user opened, and no others', () => {
    const rows = groupedGridRows(groups, toggleGroup(collapseAllGroups(), 'Mexico'));
    expect(rows.map(row => row.kind)).toEqual(['group', 'group', 'coin', 'coin']);
    expect(renderedCoins(rows).map(c => c.id)).toEqual(['mx-1', 'mx-2']);
  });

  it('draws every row once everything is expanded', () => {
    const rows = groupedGridRows(groups, expandAllGroups());
    expect(renderedCoins(rows).map(c => c.id)).toEqual(['fr-1', 'mx-1', 'mx-2']);
  });

  it('gives every row a distinct track key', () => {
    const rows = groupedGridRows(groups, expandAllGroups());
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
  });
});

describe('remembering the grouping, and surviving what was remembered', () => {
  it('round-trips a grouping and its open groups', () => {
    const expansion = toggleGroup(collapseAllGroups(), 'Mexico');
    const stored = serializeGrouping('country', expansion);

    expect(stored).toEqual({
      column: 'country',
      collapsedByDefault: true,
      exceptions: ['Mexico'],
      // The user's dragged group order travels in the same blob — one key
      // for all three, see StoredGroupingState. Empty here because nothing
      // has been dragged; group-order.spec.ts owns what goes in it.
      orders: {}
    });

    const restored = restoreGrouping(stored);
    expect(restored.column).toBe('country');
    expect(isGroupExpanded(restored.expansion, 'Mexico')).toBe(true);
    expect(isGroupExpanded(restored.expansion, 'France')).toBe(false);
  });

  it('degrades a grouping by a DELETED column to the flat grid', () => {
    // `Source` was removed from the grid. A saved grouping naming it must
    // not throw and must not leave the user looking at something he cannot
    // explain — it simply is not a grouping any more.
    const restored = restoreGrouping({ column: 'source', collapsedByDefault: true, exceptions: [] });
    expect(restored.column).toBeNull();
  });

  it('degrades a grouping by a numeric column to the flat grid', () => {
    expect(restoreGrouping({ column: 'currentValue', exceptions: [] }).column).toBeNull();
  });

  it('degrades anything unreadable at all to the flat grid, without throwing', () => {
    for (const junk of [null, undefined, 'country', 42, [], {}, { column: 7 }, { column: null }]) {
      expect(() => restoreGrouping(junk)).not.toThrow();
      expect(restoreGrouping(junk).column).toBeNull();
    }
  });

  it('treats a missing or corrupt expansion as collapsed, which is the safe half', () => {
    expect(restoreGrouping({ column: 'country' }).expansion.collapsedByDefault).toBe(true);
    const exceptions = restoreGrouping({ column: 'country', exceptions: 'Mexico' }).expansion.exceptions;
    expect([...exceptions]).toEqual([]);
  });

  it('keeps only the string headings out of a mixed exceptions array', () => {
    const restored = restoreGrouping({
      column: 'country',
      collapsedByDefault: true,
      exceptions: ['Mexico', 7, null, 'France']
    });
    expect([...restored.expansion.exceptions].sort()).toEqual(['France', 'Mexico']);
  });

  it('remembers an expanded-by-default state as well as a collapsed one', () => {
    const stored = serializeGrouping('country', expandAllGroups());
    expect(restoreGrouping(stored).expansion.collapsedByDefault).toBe(false);
  });
});
