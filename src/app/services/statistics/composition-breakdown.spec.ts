 /*
 * composition-breakdown.spec.ts
 * ---- WHAT THESE TESTS DEFEND ----
 * Two separate ways a breakdown chart lies, both of them silent:
 *
 *   1. A BLANK FIELD BECOMES A CATEGORY. Thirty coins with no country typed
 *      in get grouped under "" and drawn as a bar like any other, or — worse
 *      — bucketed as "(none)" and sorted into the middle of the ranking where
 *      it reads as a real place. Here, unlabelled coins are NEVER a slice.
 *      They come back as a separate count so the view can print "No country
 *      recorded for 30 coins" under the chart.
 *
 *   2. THE TAIL IS DROPPED. Showing the top ten of forty denominations and
 *      saying nothing about the other thirty makes the chart look like the
 *      whole collection. The fold into "Other" is explicit, counted, and
 *      always last regardless of its size.
 *
 * A third, quieter one: when the metric is VALUE, a slice's value is the sum
 * over the coins in it that have a value — which is not the same as the sum
 * over the slice. `valueUnknownCount` is how the chart admits that.
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
    // A completely different order from the count ranking — which is the
    // whole reason both metrics exist.
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
    // Ten unappraised coins against one $5 coin. A comparator that quietly
    // fell back to the count for an unvalued slice would put the big empty
    // bucket at the top of a chart whose axis is money, which is the most
    // misleading single bar this view could draw.
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
    // Eight categories of one coin each plus one of two: folding seven
    // singletons makes an Other of 7, bigger than any named bar except the 2.
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
    // Folding one slice into "Other" hides a name for no benefit at all.
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
    // formatDenominationDisplay turns "2/-" into "2 sh". Two charts of the
    // same collection must not name the same denomination differently.
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

/* ===========================================================================
 * DENOMINATION, AFTER THE REFERENCE-MODEL REFACTOR
 * ---------------------------------------------------------------------------
 * A breakdown bucket is keyed on THE STRING THE GRID SHOWS. That one decision
 * answers both of the questions this section exists for:
 *
 *   WHY UNRESOLVED COINS DO NOT SHARE A BUCKET. `Other (8 Reales)` and
 *   `Other (100 Soles)` are two different strings, so they are two different
 *   bars. Collapsing them under a single "Other" would be this file's own
 *   silent-lie #1 wearing a different hat — a bar that reads as a real
 *   denomination, sorted into the ranking by size, that is in fact a pile of
 *   unrelated coins. On the owner's un-migrated database it would be ALL 105
 *   of them in one bar, which is worse than no chart.
 *
 *   WHY A RESOLVED COIN BUCKETS UNDER ITS LABEL. Two views of one collection
 *   that name the same denomination differently make a user distrust both.
 *   The chart and the grid read the same function.
 *
 * There is no new "unknown" bucket and no `(none)` escape hatch. A coin with
 * nothing recorded at all stays out of the slices entirely, exactly as it
 * always has.
 * ======================================================================== */

describe('buildBreakdown — denomination, with the lookup loaded', () => {
  it('buckets a resolved coin under its Label, not the text it arrived with', () => {
    const breakdown = buildBreakdown(
      [statsCoin({ denominationId: MEXICO_8_REALES, denomination: 'Pillar Dollar' })],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices.map(slice => slice.label)).toEqual(['8 Reales']);
  });

  it('keeps two different unresolved denominations in two different slices', () => {
    // THE REQUIREMENT. Both of these read as unresolved on screen, and they
    // are not the same coin by any reading.
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
    // Asserted explicitly, not just as "two of something": a bucket keyed on
    // the raw text would also produce two slices here, so counting them
    // alone would not tell the two implementations apart. The LABELS are
    // what prove the chart is reading the same strings the grid prints.
    expect(breakdown.slices.map(slice => slice.label).sort())
      .toEqual(['Other (Pillar Dollar)', 'Other (Trade Dollar)']);
    expect(breakdown.slices.map(slice => slice.label)).not.toContain(OTHER_LABEL);
  });

  it('still keeps a coin with nothing recorded out of the ranking', () => {
    // The em-dash placeholder must never become a category. It would be the
    // `(none)` bar this file's header refuses, with a prettier name.
    const breakdown = buildBreakdown(
      [statsCoin({ denomination: 'Trime', country: 'United States' }), statsCoin({ denomination: '' })],
      'denomination', 'count', undefined, DENOMINATION_LOOKUP
    );
    expect(breakdown.slices.map(slice => slice.label)).toEqual(['3CS']);
    expect(breakdown.unlabelledCount).toBe(1);
    expect(breakdown.labelledCount).toBe(1);
  });

  it('counts an id-less coin and an id-bearing one as the same denomination', () => {
    // Migration 014 must not split or merge a single bar. Same text, same
    // country, one with the id written and one without.
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
    // The claim in one assertion, over every interesting shape of coin at
    // once: whatever the chart calls a coin, the grid calls it the same.
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
    // Every existing caller, and the whole app during hydration. A chart
    // that regrouped itself a beat after opening would be its own bug.
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
