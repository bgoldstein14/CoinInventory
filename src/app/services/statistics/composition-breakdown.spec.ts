 /*
  * Tests for buildBreakdown:
  *   1. Coins with a blank field are never a slice; they are returned as a
  *      separate count.
  *   2. The tail past the cap is folded into one explicit "Other" slice, always last.
  *   3. Under the value metric, `valueUnknownCount` reports unappraised coins.
  */

import { describe, expect, it } from 'vitest';
import { statsCoin } from '../../testing/stats-coins.fixture';
import {
  DENOMINATION_LOOKUP,
  GB_CROWN,
  MEXICO_8_REALES
} from '../../testing/denomination-lookup.fixture';
import { formatInventoryCell } from '../../types/inventory-columns';
import { buildBreakdown, OTHER_LABEL } from './composition-breakdown';

describe('buildBreakdown — the empty and the trivial', () => {
  it('returns no slices for an empty collection', () => {
    const breakdown = buildBreakdown([], 'country', 'count');
    expect(breakdown.slices).toEqual([]);
    expect(breakdown.labelledCount).toBe(0);
    expect(breakdown.unlabelledCount).toBe(0);
  });

  it('returns a single slice for a collection of one', () => {
    const breakdown = buildBreakdown([statsCoin({ country: 'Canada' })], 'country', 'count');
    expect(breakdown.slices).toHaveLength(1);
    expect(breakdown.slices[0].label).toBe('Canada');
    expect(breakdown.slices[0].count).toBe(1);
  });

  it('returns a single slice when every coin shares one denomination', () => {
    const coins = Array.from({ length: 40 }, () => statsCoin({ denomination: 'Dime' }));
    const breakdown = buildBreakdown(coins, 'denomination', 'count');
    expect(breakdown.slices).toHaveLength(1);
    expect(breakdown.slices[0].count).toBe(40);
    expect(breakdown.distinctLabelCount).toBe(1);
  });
});

describe('buildBreakdown — blanks are never a category', () => {
  it('keeps coins with no value in the field out of the slices entirely', () => {
    const breakdown = buildBreakdown(
      [
        statsCoin({ country: 'United States' }),
        statsCoin({ country: '' }),
        statsCoin({ country: '   ' })
      ],
      'country',
      'count'
    );

    expect(breakdown.slices.map(s => s.label)).toEqual(['United States']);
    expect(breakdown.unlabelledCount).toBe(2);
    expect(breakdown.labelledCount).toBe(1);
  });

  it('treats an absent optional field (metal) as unlabelled, not as a metal', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ metalContent: 'Silver' }), statsCoin()],
      'metal',
      'count'
    );

    expect(breakdown.slices.map(s => s.label)).toEqual(['Silver']);
    expect(breakdown.unlabelledCount).toBe(1);
  });

  it('reports every coin as unlabelled when nobody filled the field in', () => {
    const breakdown = buildBreakdown([statsCoin(), statsCoin(), statsCoin()], 'grade', 'count');
    expect(breakdown.slices).toEqual([]);
    expect(breakdown.unlabelledCount).toBe(3);
  });
});

describe('buildBreakdown — ranking', () => {
  const coins = [
    statsCoin({ category: 'Type Set', currentValue: 10 }),
    statsCoin({ category: 'Type Set', currentValue: 10 }),
    statsCoin({ category: 'Type Set', currentValue: 10 }),
    statsCoin({ category: 'Gold', currentValue: 900 }),
    statsCoin({ category: 'Ancients', currentValue: 40 }),
    statsCoin({ category: 'Ancients', currentValue: 40 })
  ];

  it('ranks by count, largest first, when the metric is count', () => {
    const breakdown = buildBreakdown(coins, 'category', 'count');
    expect(breakdown.slices.map(s => s.label)).toEqual(['Type Set', 'Ancients', 'Gold']);
  });

  it('ranks by value, largest first, when the metric is value', () => {
    // A different order from the count ranking.
    const breakdown = buildBreakdown(coins, 'category', 'value');
    expect(breakdown.slices.map(s => s.label)).toEqual(['Gold', 'Ancients', 'Type Set']);
  });

  it('breaks a tie alphabetically so the chart does not reshuffle between renders', () => {
    const tied = [statsCoin({ grade: 'MS-65' }), statsCoin({ grade: 'AU-58' })];
    expect(buildBreakdown(tied, 'grade', 'count').slices.map(s => s.label))
      .toEqual(['AU-58', 'MS-65']);
  });
});

describe('buildBreakdown — the value of a slice', () => {
  it('sums only the coins in the slice that have a recorded value', () => {
    const breakdown = buildBreakdown(
      [
        statsCoin({ country: 'France', currentValue: 100 }),
        statsCoin({ country: 'France', currentValue: 0 }),
        statsCoin({ country: 'France', currentValue: 50 })
      ],
      'country',
      'count'
    );

    const france = breakdown.slices[0];
    expect(france.count).toBe(3);
    expect(france.value).toBe(150);
    expect(france.valueKnownCount).toBe(2);
    expect(france.valueUnknownCount).toBe(1);
  });

  it('gives a slice a NULL value, not zero, when no coin in it was appraised', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ country: 'France' }), statsCoin({ country: 'France' })],
      'country',
      'count'
    );

    expect(breakdown.slices[0].value).toBeNull();
    expect(breakdown.slices[0].valueUnknownCount).toBe(2);
  });

  it('ranks an unvalued slice last under the value metric rather than crashing', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ country: 'France' }), statsCoin({ country: 'Peru', currentValue: 5 })],
      'country',
      'value'
    );
    expect(breakdown.slices.map(s => s.label)).toEqual(['Peru', 'France']);
  });

  it('ranks a LARGE unvalued slice last too — the axis says dollars, not coins', () => {
    // Ten unappraised coins vs one $5 coin: the unvalued slice must not rank
    // first on a money axis.
    const breakdown = buildBreakdown(
      [
        ...Array.from({ length: 10 }, () => statsCoin({ country: 'Unappraised' })),
        statsCoin({ country: 'Peru', currentValue: 5 })
      ],
      'country',
      'value'
    );
    expect(breakdown.slices.map(s => s.label)).toEqual(['Peru', 'Unappraised']);
  });
});

describe('buildBreakdown — folding the tail into Other', () => {
  /** Twelve distinct categories, sizes 12, 11, 10 ... 1. */
  const many = () => {
    const coins = [];
    for (let i = 12; i >= 1; i--) {
      for (let n = 0; n < i; n++) {
        coins.push(statsCoin({ category: `Cat-${String(i).padStart(2, '0')}`, currentValue: 10 }));
      }
    }
    return coins;
  };

  it('shows at most maxSlices bars, the last of which is Other', () => {
    const breakdown = buildBreakdown(many(), 'category', 'count', 5);

    expect(breakdown.slices).toHaveLength(5);
    expect(breakdown.slices[4].label).toBe(OTHER_LABEL);
    expect(breakdown.slices.slice(0, 4).map(s => s.label))
      .toEqual(['Cat-12', 'Cat-11', 'Cat-10', 'Cat-09']);
  });

  it('puts the ENTIRE tail into Other so the bars still add up to the labelled total', () => {
    const coins = many();
    const breakdown = buildBreakdown(coins, 'category', 'count', 5);

    const shown = breakdown.slices.reduce((sum, s) => sum + s.count, 0);
    expect(shown).toBe(coins.length);
    // 12+11+10+9 = 42 in the named bars, the remaining 36 folded.
    expect(breakdown.slices[4].count).toBe(36);
    expect(breakdown.slices[4].foldedSliceCount).toBe(8);
  });

  it('keeps Other last even when the folded tail outweighs every named slice', () => {
    // Eight singletons plus one of two: the folded Other (7) outranks named bars.
    const coins = [
      statsCoin({ category: 'Big' }),
      statsCoin({ category: 'Big' }),
      ...Array.from({ length: 7 }, (_, i) => statsCoin({ category: `Small-${i}` }))
    ];
    const breakdown = buildBreakdown(coins, 'category', 'count', 2);

    expect(breakdown.slices.map(s => s.label)).toEqual(['Big', OTHER_LABEL]);
    expect(breakdown.slices[1].count).toBe(7);
  });

  it('does NOT create an Other bar holding a single category — it names it', () => {
    // Folding a single slice into "Other" would only hide a name.
    const coins = [
      statsCoin({ category: 'A' }), statsCoin({ category: 'A' }),
      statsCoin({ category: 'B' }),
      statsCoin({ category: 'C' })
    ];
    const breakdown = buildBreakdown(coins, 'category', 'count', 3);

    expect(breakdown.slices.map(s => s.label)).toEqual(['A', 'B', 'C']);
    expect(breakdown.slices.some(s => s.label === OTHER_LABEL)).toBe(false);
  });

  it('sums the folded slices values too, and carries their unknown counts', () => {
    const coins = [
      statsCoin({ category: 'A', currentValue: 500 }),
      statsCoin({ category: 'B', currentValue: 100 }),
      statsCoin({ category: 'C', currentValue: 60 }),
      statsCoin({ category: 'D', currentValue: 0 })
    ];
    const breakdown = buildBreakdown(coins, 'category', 'value', 2);

    const other = breakdown.slices[1];
    expect(other.label).toBe(OTHER_LABEL);
    expect(other.count).toBe(3);
    expect(other.value).toBe(160);
    expect(other.valueUnknownCount).toBe(1);
  });

  it('reports the true number of distinct labels even after folding', () => {
    const breakdown = buildBreakdown(many(), 'category', 'count', 5);
    expect(breakdown.distinctLabelCount).toBe(12);
  });
});

describe('buildBreakdown — denomination labels match the grid', () => {
  it('renders shilling shorthand the way the inventory table does', () => {
    // Same display as the grid: "2/-" becomes "2 sh".
    const breakdown = buildBreakdown([statsCoin({ denomination: '2/-' })], 'denomination', 'count');
    expect(breakdown.slices[0].label).toBe('2 sh');
  });

  it('groups two spellings of the same denomination into one slice', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ denomination: '2/-' }), statsCoin({ denomination: '2 Shilling' })],
      'denomination',
      'count'
    );
    expect(breakdown.slices).toHaveLength(1);
    expect(breakdown.slices[0].count).toBe(2);
  });
});

/*
 * Denomination buckets are keyed on the string the grid shows. So unresolved
 * `Other (8 Reales)` and `Other (100 Soles)` are separate bars, a resolved coin
 * buckets under its label, and a coin with nothing recorded stays out of the slices.
 */

describe('buildBreakdown — denomination, with the lookup loaded', () => {
  it('buckets a resolved coin under its Label, not the text it arrived with', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' })],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices.map(slice => slice.label)).toEqual(['8 Reales']);
  });

  it('keeps two different unresolved denominations in two different slices', () => {
    // Two different unresolved denominations must stay separate.
    const breakdown = buildBreakdown(
      [
        statsCoin({ denomination: 'Pillar Dollar' }),
        statsCoin({ denomination: 'Trade Dollar' })
      ],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices).toHaveLength(2);
    expect(breakdown.slices.map(slice => slice.count)).toEqual([1, 1]);
    expect(breakdown.distinctLabelCount).toBe(2);
    // Checking labels, not just the count, proves the chart reads the grid's strings.
    expect(breakdown.slices.map(slice => slice.label).sort())
      .toEqual(['Other (Pillar Dollar)', 'Other (Trade Dollar)']);
    expect(breakdown.slices.map(slice => slice.label)).not.toContain(OTHER_LABEL);
  });

  it('still keeps a coin with nothing recorded out of the ranking', () => {
    // The em-dash placeholder must never become a category.
    const breakdown = buildBreakdown(
      [statsCoin({ denomination: 'Trime', country: 'United States' }), statsCoin({ denomination: '' })],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices.map(slice => slice.label)).toEqual(['3CS']);
    expect(breakdown.unlabelledCount).toBe(1);
    expect(breakdown.labelledCount).toBe(1);
  });

  it('counts an id-less coin and an id-bearing one as the same denomination', () => {
    // Same text and country, one with the id and one without: one bar.
    const breakdown = buildBreakdown(
      [
        statsCoin({ denomination: '8 Reales', country: 'United States' }),
        statsCoin({ denominationId: MEXICO_8_REALES, denomination: '8 Reales', country: 'United States' })
      ],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices).toHaveLength(1);
    expect(breakdown.slices[0].label).toBe('8 Reales');
    expect(breakdown.slices[0].count).toBe(2);
  });

  it('normalises a resolved label exactly as the grid does', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ denominationId: GB_CROWN, denomination: '5s' })],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices[0].label).toBe('5 sh (Crown)');
  });

  it('labels every slice with the string the inventory grid would print', () => {
    // Whatever the chart calls a coin, the grid calls it the same.
    const coins = [
      statsCoin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' }),
      statsCoin({ denomination: 'Trade Dollar' }),
      statsCoin({ denomination: 'Trime', country: 'United States' }),
      statsCoin({ denomination: 'Crown', country: 'United States' })
    ];
    const breakdown = buildBreakdown(coins, 'denomination', 'count', undefined, DENOMINATION_LOOKUP);
    const fromTheGrid = coins.map(
      coin => formatInventoryCell(coin, 'denomination', undefined, undefined, DENOMINATION_LOOKUP)
    );
    expect(breakdown.slices.map(slice => slice.label).sort()).toEqual([...fromTheGrid].sort());
  });
});

describe('buildBreakdown — denomination, before the lookup arrives', () => {
  it('buckets exactly as it always has when no lookup is passed', () => {
    // Without the lookup (e.g. during hydration).
    const coins = [
      statsCoin({ denomination: '2/-' }),
      statsCoin({ denomination: '2 Shilling' }),
      statsCoin({ denomination: 'Trade Dollar' }),
      statsCoin({ denomination: '' })
    ];
    const breakdown = buildBreakdown(coins, 'denomination', 'count');
    expect(breakdown.slices.map(slice => slice.label).sort()).toEqual(['2 sh', 'Trade Dollar']);
    expect(breakdown.unlabelledCount).toBe(1);
  });
});
