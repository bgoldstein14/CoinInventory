 /*
 * chart-geometry.spec.ts
 *
 * The charts are hand-rolled SVG partly so they can be tested at all: this
 * suite runs under Node with NO jsdom, so a library-backed chart could only
 * ever be asserted as "we called the library". See chart-geometry.ts for the
 * rest of that reasoning.
 *
 * What is pinned here is the mark rules, so a later "tidy-up" that thickens a
 * bar to fill its row, drops the 2px gap, or lets a value label overflow its
 * bar fails a test:
 *
 *   - bars <= 24px thick, with a >= 2px surface gap between neighbours
 *   - a 4px rounded data-end, SQUARE at the baseline
 *   - a value never clipped by its own bar: outside the tip if it fits there,
 *     inside the bar end if it fits there, otherwise not drawn at all (the
 *     tooltip carries it)
 *   - a zero draws nothing rather than a 1px sliver that reads as a value
  */

import { describe, expect, it } from 'vitest';
import {
  MAX_BAR_THICKNESS,
  barPath,
  estimateTextWidth,
  layoutLineChart,
  layoutRankedBars,
  nearestPointIndex,
  niceTicks,
  truncateLabel
} from './chart-geometry';

// ---- barPath ----

describe('barPath', () => {
  it('rounds the data-end and leaves the baseline end square', () => {
    // Square corners at x=0 (the baseline), 4px arcs at x=100 (the value).
    expect(barPath(0, 0, 100, 20)).toBe(
      'M 0 0 H 96 A 4 4 0 0 1 100 4 V 16 A 4 4 0 0 1 96 20 H 0 Z'
    );
  });

  it('shrinks the radius rather than letting the arcs cross on a short bar', () => {
    expect(barPath(10, 5, 3, 20)).toBe(
      'M 10 5 H 10 A 3 3 0 0 1 13 8 V 22 A 3 3 0 0 1 10 25 H 10 Z'
    );
  });

  it('draws NOTHING for a zero-length bar', () => {
    // A hairline where a category has no value reads as a small value.
    expect(barPath(0, 0, 0, 20)).toBe('');
    expect(barPath(0, 0, -5, 20)).toBe('');
  });

  it('rounds coordinates so the markup does not carry float noise', () => {
    expect(barPath(0, 0, 100 / 3, 20)).toContain('33.33');
  });
});

// ---- estimateTextWidth / truncateLabel ----

describe('estimateTextWidth', () => {
  it('grows with the text and with the font size', () => {
    expect(estimateTextWidth('abcd', 10)).toBeGreaterThan(estimateTextWidth('ab', 10));
    expect(estimateTextWidth('abcd', 20)).toBeGreaterThan(estimateTextWidth('abcd', 10));
  });

  it('is zero for empty text', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
  });
});

describe('truncateLabel', () => {
  it('leaves a label that fits completely alone', () => {
    expect(truncateLabel('Dime', 200, 12)).toBe('Dime');
  });

  it('cuts an over-long label and marks the cut with an ellipsis', () => {
    const cut = truncateLabel('Standing Liberty Quarter Dollar', 60, 12);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThan('Standing Liberty Quarter Dollar'.length);
    expect(estimateTextWidth(cut, 12)).toBeLessThanOrEqual(60);
  });

  it('never returns something longer than the original', () => {
    expect(truncateLabel('AB', 1, 12).length).toBeLessThanOrEqual(2);
  });
});

// ---- layoutRankedBars ----

const BAR_OPTS = {
  width: 400,
  labelWidth: 100,
  valueWidth: 80,
  rowHeight: 24
};

describe('layoutRankedBars — the empty case', () => {
  it('produces no bars and a zero-height chart', () => {
    const chart = layoutRankedBars([], BAR_OPTS);
    expect(chart.bars).toEqual([]);
    expect(chart.height).toBe(0);
  });
});

describe('layoutRankedBars — scaling', () => {
  const items = [
    { label: 'Dime', value: 100, valueText: '100' },
    { label: 'Quarter', value: 50, valueText: '50' },
    { label: 'Cent', value: 0, valueText: '0' }
  ];

  it('gives the largest value the full plot width', () => {
    const chart = layoutRankedBars(items, BAR_OPTS);
    // 400 total - 100 label gutter - 80 value gutter = 220 of plot.
    expect(chart.plotWidth).toBe(220);
    expect(chart.bars[0].width).toBe(220);
  });

  it('scales the rest in proportion', () => {
    const chart = layoutRankedBars(items, BAR_OPTS);
    expect(chart.bars[1].width).toBe(110);
  });

  it('gives a zero value a zero-width bar and an empty path', () => {
    const chart = layoutRankedBars(items, BAR_OPTS);
    expect(chart.bars[2].width).toBe(0);
    expect(chart.bars[2].path).toBe('');
  });

  it('starts every bar at the same baseline, immediately after the label gutter', () => {
    const chart = layoutRankedBars(items, BAR_OPTS);
    expect(chart.bars.map(b => b.x)).toEqual([100, 100, 100]);
    expect(chart.plotLeft).toBe(100);
  });

  it('draws nothing at all when every value is zero — no full-width bars', () => {
    // max = 0. Dividing by it would give NaN; defaulting it to 1 would make
    // every bar full width, which says "all equal and large" about a
    // collection where nothing is known.
    const chart = layoutRankedBars(
      [
        { label: 'A', value: 0, valueText: '—' },
        { label: 'B', value: 0, valueText: '—' }
      ],
      BAR_OPTS
    );
    expect(chart.bars.map(b => b.width)).toEqual([0, 0]);
    expect(chart.max).toBe(0);
  });

  it('handles a value a billion times the next without losing the small one', () => {
    const chart = layoutRankedBars(
      [
        { label: 'Big', value: 1e9, valueText: '1B' },
        { label: 'Small', value: 1, valueText: '1' }
      ],
      BAR_OPTS
    );
    expect(chart.bars[0].width).toBe(220);
    expect(chart.bars[1].width).toBeGreaterThan(0);
    expect(chart.bars[1].width).toBeLessThan(0.001);
  });
});

describe('layoutRankedBars — mark specs', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({
    label: `L${i}`,
    value: 10,
    valueText: '10'
  }));

  it('never lets a bar exceed the 24px thickness cap, however tall the row', () => {
    const chart = layoutRankedBars(items, { ...BAR_OPTS, rowHeight: 80 });
    for (const bar of chart.bars) {
      expect(bar.height).toBeLessThanOrEqual(MAX_BAR_THICKNESS);
    }
  });

  it('leaves at least a 2px surface gap between neighbouring bars', () => {
    const chart = layoutRankedBars(items, { ...BAR_OPTS, rowHeight: 16, barThickness: 24 });
    const gap = chart.bars[1].y - (chart.bars[0].y + chart.bars[0].height);
    expect(gap).toBeGreaterThanOrEqual(2);
  });

  it('centres each bar in its row', () => {
    const chart = layoutRankedBars(items, { ...BAR_OPTS, rowHeight: 30, barThickness: 10 });
    expect(chart.bars[0].y).toBe(10);
    expect(chart.bars[1].y).toBe(40);
  });

  it('gives every bar a hit target of at least 24px, even a thin one', () => {
    const chart = layoutRankedBars(items, { ...BAR_OPTS, rowHeight: 14, barThickness: 8 });
    for (const bar of chart.bars) {
      expect(bar.hitHeight).toBeGreaterThanOrEqual(24);
    }
  });

  it('spans the whole chart width with the hit target, not just the painted bar', () => {
    const chart = layoutRankedBars(items, BAR_OPTS);
    expect(chart.bars[0].hitX).toBe(0);
    expect(chart.bars[0].hitWidth).toBe(BAR_OPTS.width);
  });
});

describe('layoutRankedBars — where the value label goes', () => {
  it('puts the value just past the tip when the reserved gutter holds it', () => {
    const chart = layoutRankedBars(
      [{ label: 'Dime', value: 10, valueText: '$1,234.56' }],
      { ...BAR_OPTS, valueWidth: 80 }
    );
    const bar = chart.bars[0];

    expect(bar.valueVisible).toBe(true);
    expect(bar.valueInside).toBe(false);
    expect(bar.valueAnchor).toBe('start');
    expect(bar.valueX).toBeGreaterThan(bar.x + bar.width);
  });

  it('moves the value inside the bar end when the gutter is too narrow for it', () => {
    // A long value text and almost no gutter: outside would overflow the
    // SVG, so it goes inside the (wide) bar, right-anchored at the end.
    const chart = layoutRankedBars(
      [{ label: 'Dime', value: 10, valueText: '$123,456,789.00' }],
      { ...BAR_OPTS, width: 400, labelWidth: 60, valueWidth: 4 }
    );
    const bar = chart.bars[0];

    expect(bar.valueVisible).toBe(true);
    expect(bar.valueInside).toBe(true);
    expect(bar.valueAnchor).toBe('end');
    expect(bar.valueX).toBeLessThanOrEqual(bar.x + bar.width);
  });

  it('DROPS the value rather than clipping it when it fits in neither place', () => {
    // The anti-pattern this prevents: `overflow: hidden` on the segment,
    // which crops the first or last characters and is worse than no label.
    // The value stays reachable on hover and in the figures beside the chart.
    const chart = layoutRankedBars(
      [{ label: 'Tiny', value: 1, valueText: '$1,234,567.89' }],
      { width: 200, labelWidth: 150, valueWidth: 2, rowHeight: 24 }
    );

    expect(chart.bars[0].valueVisible).toBe(false);
  });
});

// ---- niceTicks ----

describe('niceTicks', () => {
  it('rounds to clean numbers that span the data', () => {
    expect(niceTicks(0, 900, 5)).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it('always includes the floor and reaches past the maximum', () => {
    const ticks = niceTicks(0, 1234, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(1234);
  });

  it('produces clean decimals without binary-float noise', () => {
    // The classic failure: 0.1 + 0.2 === 0.30000000000000004 printed on an axis.
    for (const tick of niceTicks(0, 1, 5)) {
      expect(String(tick).length).toBeLessThan(6);
    }
  });

  it('copes with a degenerate range instead of dividing by zero', () => {
    expect(niceTicks(0, 0, 5)).toEqual([0, 1]);
  });

  it('copes with a collection worth tens of millions', () => {
    const ticks = niceTicks(0, 48_000_000, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(48_000_000);
    expect(ticks.length).toBeLessThanOrEqual(12);
  });

  it('copes with a collection worth a few cents', () => {
    const ticks = niceTicks(0, 0.05, 5);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(0.05);
  });
});

// ---- layoutLineChart ----

const LINE_OPTS = {
  width: 600,
  height: 220,
  padLeft: 60,
  padRight: 20,
  padTop: 16,
  padBottom: 28
};

describe('layoutLineChart — the empty and the single', () => {
  it('produces no path at all for an empty series', () => {
    const chart = layoutLineChart([], LINE_OPTS);
    expect(chart.points).toEqual([]);
    expect(chart.linePath).toBe('');
    expect(chart.areaPath).toBe('');
  });

  it('centres a lone point rather than dividing by a zero x-range', () => {
    const chart = layoutLineChart([{ x: 1700000000000, y: 250 }], LINE_OPTS);
    expect(chart.points).toHaveLength(1);
    expect(chart.points[0].x).toBe((LINE_OPTS.padLeft + (600 - 20)) / 2);
    expect(Number.isFinite(chart.points[0].y)).toBe(true);
  });

  it('gives a lone point a single x tick, not a crowded axis', () => {
    const chart = layoutLineChart([{ x: 1700000000000, y: 250 }], LINE_OPTS);
    expect(chart.xTicks).toHaveLength(1);
  });
});

describe('layoutLineChart — scaling', () => {
  const series = [
    { x: 0, y: 0 },
    { x: 50, y: 500 },
    { x: 100, y: 1000 }
  ];

  it('anchors the first and last points to the plot edges', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    expect(chart.points[0].x).toBe(60);
    expect(chart.points[2].x).toBe(580);
  });

  it('puts zero on the baseline and the maximum at the top of the y scale', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    // y grows downwards in SVG, so the biggest value has the SMALLEST y.
    expect(chart.points[0].y).toBe(chart.plotBottom);
    expect(chart.points[2].y).toBeLessThan(chart.points[0].y);
  });

  it('always includes zero in the y scale — a money curve starts at nothing', () => {
    const chart = layoutLineChart([{ x: 0, y: 900 }, { x: 1, y: 1000 }], LINE_OPTS);
    expect(chart.yTicks[0].value).toBe(0);
  });

  it('writes a move-then-line path through every point', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    expect(chart.linePath.startsWith('M ')).toBe(true);
    expect(chart.linePath.split('L')).toHaveLength(3);
  });

  it('closes the area path back along the baseline', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    expect(chart.areaPath.endsWith('Z')).toBe(true);
    expect(chart.areaPath).toContain(`V ${chart.plotBottom}`);
  });

  it('keeps every point inside the padded plot area', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    for (const point of chart.points) {
      expect(point.x).toBeGreaterThanOrEqual(chart.plotLeft);
      expect(point.x).toBeLessThanOrEqual(chart.plotRight);
      expect(point.y).toBeGreaterThanOrEqual(chart.plotTop);
      expect(point.y).toBeLessThanOrEqual(chart.plotBottom);
    }
  });

  it('carries the original data values through for the tooltip', () => {
    const chart = layoutLineChart(series, LINE_OPTS);
    expect(chart.points[1].dataX).toBe(50);
    expect(chart.points[1].dataY).toBe(500);
    expect(chart.points[1].index).toBe(1);
  });
});

describe('nearestPointIndex', () => {
  const chart = layoutLineChart(
    [{ x: 0, y: 1 }, { x: 50, y: 2 }, { x: 100, y: 3 }],
    LINE_OPTS
  );

  it('snaps to the nearest point so the reader aims at a date, not a 2px line', () => {
    expect(nearestPointIndex(chart.points, chart.points[1].x + 3)).toBe(1);
  });

  it('clamps to the first point left of the plot', () => {
    expect(nearestPointIndex(chart.points, -500)).toBe(0);
  });

  it('clamps to the last point right of the plot', () => {
    expect(nearestPointIndex(chart.points, 5000)).toBe(2);
  });

  it('returns -1 for an empty series rather than throwing', () => {
    expect(nearestPointIndex([], 10)).toBe(-1);
  });
});
