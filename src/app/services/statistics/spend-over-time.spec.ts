 /*
  * Tests for the cumulative spend curve. `purchaseDate` is free text stored
  * verbatim, so unparseable dates are neither guessed nor dropped: they are
  * counted and reported.
  */

import { describe, expect, it } from 'vitest';
import { statsCoin } from '../../testing/stats-coins.fixture';
import { computeSpendOverTime, parsePurchaseDate } from './spend-over-time';

describe('parsePurchaseDate', () => {
  it('accepts the ISO form the Quicken importer writes', () => {
    expect(parsePurchaseDate('2024-03-15')).toBe('2024-03-15');
  });

  it('accepts an ISO timestamp by taking its date part', () => {
    expect(parsePurchaseDate('2024-03-15T00:00:00.000Z')).toBe('2024-03-15');
  });

  it('accepts the US slash form a hand edit or a CSV can produce', () => {
    expect(parsePurchaseDate('3/15/2024')).toBe('2024-03-15');
    expect(parsePurchaseDate('03/05/2024')).toBe('2024-03-05');
  });

  it('rejects a blank date', () => {
    expect(parsePurchaseDate('')).toBeNull();
    expect(parsePurchaseDate('   ')).toBeNull();
  });

  it('rejects free text rather than guessing at it', () => {
    expect(parsePurchaseDate('sometime in 2019')).toBeNull();
    expect(parsePurchaseDate('unknown')).toBeNull();
  });

  it('rejects a calendar-impossible date instead of rolling it over', () => {
    // `new Date('2024-02-31')` silently becomes 2 March; this must be rejected.
    expect(parsePurchaseDate('2024-02-31')).toBeNull();
    expect(parsePurchaseDate('2024-13-01')).toBeNull();
  });

  it('rejects a bare year — it cannot be placed on a day axis', () => {
    expect(parsePurchaseDate('2019')).toBeNull();
  });
});

describe('computeSpendOverTime — the empty and the trivial', () => {
  it('returns no points for an empty collection', () => {
    const series = computeSpendOverTime([]);
    expect(series.points).toEqual([]);
    expect(series.datedCoinCount).toBe(0);
    expect(series.undatedCoinCount).toBe(0);
  });

  it('returns one point for one dated, priced coin', () => {
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 250 })
    ]);

    expect(series.points).toHaveLength(1);
    expect(series.points[0].date).toBe('2024-03-15');
    expect(series.points[0].spend).toBe(250);
    expect(series.points[0].cumulativeSpend).toBe(250);
    expect(series.points[0].cumulativeCoins).toBe(1);
  });
});

describe('computeSpendOverTime — the curve', () => {
  const coins = [
    statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 100 }),
    statsCoin({ purchaseDate: '2022-01-02', purchasePrice: 500 }),
    statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 50 }),
    statsCoin({ purchaseDate: '2023-06-30', purchasePrice: 250 })
  ];

  it('sorts into date order whatever order the coins arrive in', () => {
    const series = computeSpendOverTime(coins);
    expect(series.points.map(p => p.date)).toEqual(['2022-01-02', '2023-06-30', '2024-03-15']);
  });

  it('collapses two purchases on one day into one point', () => {
    const series = computeSpendOverTime(coins);
    const march = series.points[2];
    expect(march.spend).toBe(150);
    expect(march.coins).toBe(2);
  });

  it('accumulates, so the curve only ever rises', () => {
    const series = computeSpendOverTime(coins);
    expect(series.points.map(p => p.cumulativeSpend)).toEqual([500, 750, 900]);
    expect(series.points.map(p => p.cumulativeCoins)).toEqual([1, 2, 4]);
  });

  it('gives each point a sortable timestamp for the x-axis', () => {
    const series = computeSpendOverTime(coins);
    expect(series.points[0].time).toBe(Date.UTC(2022, 0, 2));
    expect(series.points[1].time).toBeGreaterThan(series.points[0].time);
  });
});

describe('computeSpendOverTime — what it refuses to draw', () => {
  it('leaves an undated coin off the curve and counts it', () => {
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 100 }),
      statsCoin({ purchaseDate: '', purchasePrice: 900 })
    ]);

    expect(series.points).toHaveLength(1);
    expect(series.points[0].cumulativeSpend).toBe(100);
    expect(series.undatedCoinCount).toBe(1);
    expect(series.undatedSpend).toBe(900);
  });

  it('reports the undated spend so the view can say the curve is short of it', () => {
    // Spend on undated coins must be reported, not silently left off.
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-03-15', purchasePrice: 100 }),
      statsCoin({ purchaseDate: 'who knows', purchasePrice: 900 })
    ]);
    expect(series.undatedSpend).toBe(900);
    expect(series.undatedCoinCount).toBe(1);
  });

  it('keeps a dated but unpriced coin ON the curve, as a step of zero', () => {
    // Dated but unpriced: on the curve for coin count, not for spend.
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-01-01', purchasePrice: 200 }),
      statsCoin({ purchaseDate: '2024-02-01', purchasePrice: 0 })
    ]);

    expect(series.points).toHaveLength(2);
    expect(series.points[1].cumulativeSpend).toBe(200);
    expect(series.points[1].cumulativeCoins).toBe(2);
    expect(series.datedButUnpricedCount).toBe(1);
  });

  it('refuses a curve made entirely of unpriced coins', () => {
    // All unpriced: a flat zero line would read as "spent nothing".
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-01-01' }),
      statsCoin({ purchaseDate: '2024-02-01' })
    ]);

    expect(series.points).toEqual([]);
    expect(series.datedButUnpricedCount).toBe(2);
  });

  it('ignores a negative price rather than letting the curve fall', () => {
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-01-01', purchasePrice: 100 }),
      statsCoin({ purchaseDate: '2024-02-01', purchasePrice: -40 })
    ]);
    expect(series.points.map(p => p.cumulativeSpend)).toEqual([100, 100]);
    expect(series.datedButUnpricedCount).toBe(1);
  });
});

describe('computeSpendOverTime — extremes', () => {
  it('keeps cents straight over a thousand purchases', () => {
    const coins = Array.from({ length: 1000 }, (_, i) =>
      statsCoin({
        purchaseDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
        purchasePrice: 99.99
      })
    );
    const series = computeSpendOverTime(coins);
    const last = series.points[series.points.length - 1];

    expect(series.points).toHaveLength(12);
    expect(last.cumulativeSpend).toBeCloseTo(99990, 2);
    expect(last.cumulativeCoins).toBe(1000);
  });

  it('spans decades without reordering', () => {
    const series = computeSpendOverTime([
      statsCoin({ purchaseDate: '2024-05-05', purchasePrice: 1 }),
      statsCoin({ purchaseDate: '1971-08-15', purchasePrice: 1 }),
      statsCoin({ purchaseDate: '1999-12-31', purchasePrice: 1 })
    ]);
    expect(series.points.map(p => p.date)).toEqual(['1971-08-15', '1999-12-31', '2024-05-05']);
  });
});
