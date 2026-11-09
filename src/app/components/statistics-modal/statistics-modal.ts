import { Component, computed, inject, output, signal } from '@angular/core';
import { InventoryService } from '../../services/inventory.service';
import { collectionNotReadyNotice } from '../../features/inventory/collection-zero-state';
import {
  BreakdownDimension,
  BreakdownMetric,
  OTHER_LABEL,
  buildBreakdown
} from '../../services/statistics/composition-breakdown';
import { computeCollectionTotals } from '../../services/statistics/collection-totals';
import { computePreciousMetalHoldings } from '../../services/statistics/precious-metal-holdings';
import { computeSpendOverTime } from '../../services/statistics/spend-over-time';
import {
  layoutLineChart,
  layoutRankedBars,
  nearestPointIndex,
  truncateLabel
} from '../../services/statistics/chart-geometry';
import {
  coverageNote,
  formatAxisTick,
  formatChartDay,
  formatChartMonth,
  formatCount,
  formatGrams,
  formatStatDelta,
  formatStatMoney,
  formatTroyOunces
} from '../../services/statistics/stats-format';

/*
 * StatisticsModal — the "Statistics" dialog.
 *
 * A THIN RENDERER, by constraint rather than by taste. Every figure comes out
 * of a pure module under `services/statistics/` and every SVG coordinate out
 * of `chart-geometry.ts`; this file maps those answers onto strings and
 * signals and does no arithmetic of its own. The frontend suite runs under
 * Node with NO jsdom, so anything calculated in this class — or in the
 * template — would be untestable by construction.
 *
 * THE RULE EVERY FIGURE ON THIS SCREEN OBEYS: a visible blank beats a
 * silently wrong number (the project's governing principle, stated at the top
 * of services/pm-reference.ts). The statistics modules return `null` for
 * "cannot say" plus a count of the coins they could not account for; this
 * class renders the null as "—" and the count as a sentence underneath. It
 * never substitutes a zero and never silently averages a blank in.
 *
 * NO CHARTING LIBRARY. The production initial bundle is 752 kB against a
 * 500 kB warning and a 1 MB HARD ERROR budget (angular.json); Chart.js is
 * ~200 kB minified and ECharts around 1 MB. The geometry needed here is a few
 * dozen lines of arithmetic, adds zero dependency bytes, and — decisively,
 * given the no-jsdom constraint — is unit-testable to the pixel.
 *
 * THE CHART SVGs HAVE A FIXED PIXEL WIDTH AND NO viewBox SCALING. The
 * crosshair reads `PointerEvent.offsetX`, which is in CSS pixels; under a
 * `viewBox` with `width="100%"` those pixels are NOT user units, so the
 * crosshair would drift further from the pointer the more the chart scaled —
 * and there is no DOM in the tests to catch it. A fixed width means offsetX
 * IS the user-unit x, exactly, and the dialog scrolls horizontally on a very
 * narrow window instead of lying about where the pointer is.
 */

/** Geometry of the composition chart. Fixed — see the header. */
const BAR_CHART = {
  width: 700,
  /** Room for a denomination or country name on the left. */
  labelWidth: 150,
  /** Reserved for the value at the bar's tip. */
  valueWidth: 96,
  rowHeight: 26,
  barThickness: 16
} as const;

/** Geometry of the cumulative-spend chart. */
const SPEND_CHART = {
  width: 700,
  height: 220,
  /** Wide enough for a "$10,000" y tick. */
  padLeft: 72,
  padRight: 28,
  padTop: 18,
  padBottom: 30,
  tickCount: 4,
  xTickCount: 5
} as const;

/** Font size the bar labels are drawn at; geometry needs it to fit text. */
const LABEL_FONT_SIZE = 11;

/**
 * The unconditional footnote under the spend chart.
 *
 * UNCONDITIONAL ON PURPOSE. The absence of a value-over-time line otherwise
 * reads as a missing feature or a broken chart, rather than as the honest
 * consequence of each coin storing one overwritable Current Value and no
 * history to plot.
 */
const VALUE_HISTORY_NOTE =
  'This is money spent, not what the collection has been worth. Each coin stores one ' +
  'Current Value, overwritten whenever it is re-appraised, so no history of value exists ' +
  'to plot. Recording one — a CoinValueHistory table, one row per re-valuation, exactly ' +
  'as spot prices are already kept — is what a value-over-time line would need.';

export interface StatTile {
  label: string;
  /** The figure. "—" when it is not known. */
  value: string;
  /** A secondary figure on the same tile, or null. */
  detail: string | null;
  /** "Not recorded for 31 of 125 coins", or null when nothing is missing. */
  note: string | null;
  /**
   * Direction, for the gain/loss colouring.
   *
   * NEVER the only cue. The tile's LABEL changes between "Unrealised gain"
   * and "Unrealised loss" and the figure carries an explicit +/- sign, so the
   * meaning survives greyscale, print and a red/green deficiency. The app's
   * `.gain` green measures 2.87:1 against white — below the 3:1 the guidance
   * wants — so colour here is a third cue rather than the first.
   */
  tone: 'gain' | 'loss' | null;
}

interface DimensionOption {
  key: BreakdownDimension;
  label: string;
}

@Component({
  selector: 'app-statistics-modal',
  imports: [],
  templateUrl: './statistics-modal.html',
  styleUrl: './statistics-modal.scss'
})
export class StatisticsModal {
  private readonly inventoryService = inject(InventoryService);

  readonly closed = output<void>();

  protected readonly dimensionOptions: readonly DimensionOption[] = [
    { key: 'denomination', label: 'Denomination' },
    { key: 'country', label: 'Country' },
    { key: 'grade', label: 'Grade' },
    { key: 'category', label: 'Category' },
    { key: 'metal', label: 'Metal' }
  ];

  protected readonly dimension = signal<BreakdownDimension>('denomination');
  protected readonly metric = signal<BreakdownMetric>('count');

  /** Which bar the pointer or keyboard focus is on. Null for none. */
  private readonly hoveredBar = signal<number | null>(null);

  /** Which point of the spend curve the crosshair is snapped to. */
  private readonly crosshair = signal<number | null>(null);

  /** Whether the spend chart's table twin is expanded. */
  protected readonly showSpendTable = signal(false);

  protected readonly barChartWidth = BAR_CHART.width;
  protected readonly barChartLabelWidth = BAR_CHART.labelWidth;
  protected readonly spendChartWidth = SPEND_CHART.width;
  protected readonly spendChartHeight = SPEND_CHART.height;
  protected readonly labelFontSize = LABEL_FONT_SIZE;

  private get inv() {
    return this.inventoryService;
  }

  /**
   * Has the collection actually arrived?
   *
   * Every figure on this screen is computed over `inv.inventory()`, which is
   * an empty array until hydration finishes — rendered then, the screen
   * states with complete confidence that the collection is worth $0.00 and
   * contains no gold. `connected()` is what makes the difference knowable:
   * ConnectionManager.hydrate() sets it only once the coin fetch has come
   * back. The wording lives in the pure module
   * features/inventory/collection-zero-state.ts, because nothing decided in
   * a template can be tested without jsdom.
   */
  protected readonly notReadyNotice = computed(() =>
    collectionNotReadyNotice({
      loaded: this.inv.connected(),
      failed: this.inv.connectionError() !== null
    })
  );

  // --- The numbers ---

  /**
   * Statistics are over the WHOLE collection, never the filtered grid.
   *
   * "Total current value" that silently means "of the 12 coins matching your
   * search" is the same class of lie this whole screen is built to avoid, and
   * a dialog has no filter bar visible to explain itself with.
   */
  private readonly coins = computed(() => this.inv.inventory());

  private readonly totals = computed(() =>
    computeCollectionTotals(this.coins(), this.inv.spotPrices())
  );

  private readonly holdings = computed(() => computePreciousMetalHoldings(this.coins()));

  /**
   * The ranked-bar chart's data.
   *
   * The two trailing arguments are both deliberate. `undefined` keeps
   * composition-breakdown.ts's own MAX_SLICES as the one place the cap is
   * written down. The denominations lookup is what lets a `denomination`
   * breakdown name its bars the way the inventory grid does: the string on
   * screen is derived from `denominationId`, and a chart reading the raw
   * column would label the same coin differently from the table the user
   * just came from.
   */
  protected readonly breakdown = computed(() =>
    buildBreakdown(this.coins(), this.dimension(), this.metric(), undefined, this.inv.denominations())
  );

  private readonly spend = computed(() => computeSpendOverTime(this.coins()));

  // --- Figures: the hero and the tile row ---

  /** The one number the dialog leads with: what the collection is worth. */
  protected readonly hero = computed(() => {
    const { currentValue, coinCount } = this.totals();
    return {
      value: formatStatMoney(currentValue.total),
      note: coverageNote(currentValue.knownCount, coinCount)
    };
  });

  protected readonly headlineTiles = computed<StatTile[]>(() => {
    const t = this.totals();
    const tiles: StatTile[] = [];

    tiles.push({
      label: 'Coins',
      value: formatCount(t.coinCount),
      detail: null,
      // The only figure here with no gap in it: a coin is either in the
      // inventory or it is not.
      note: null,
      tone: null
    });

    tiles.push({
      label: 'Total cost',
      value: formatStatMoney(t.cost.total),
      detail: null,
      note: coverageNote(t.cost.knownCount, t.coinCount),
      tone: null
    });

    const gain = t.gainLoss.total;
    tiles.push({
      // The WORD changes with the direction, so the tile does not depend on
      // its colour being seen. See StatTile.tone.
      label: gain !== null && gain < 0 ? 'Unrealised loss' : 'Unrealised gain',
      value: formatStatDelta(gain),
      detail: t.gainLossPercent === null ? null : `${t.gainLossPercent.toFixed(1)}% of cost`,
      note: coverageNote(t.gainLoss.knownCount, t.coinCount),
      tone: gain === null || gain === 0 ? null : gain > 0 ? 'gain' : 'loss'
    });

    tiles.push({
      label: 'Melt value',
      value: formatStatMoney(t.melt.total),
      detail: null,
      note: this.meltNote(t.melt.knownCount, t.coinCount),
      tone: null
    });

    // Only once something has actually been sold. A permanent "Realised: —"
    // on a collection nobody has sold out of is a gap that is not a gap.
    if (t.realised.total !== null) {
      tiles.push({
        label: 'Realised proceeds',
        value: formatStatMoney(t.realised.total),
        detail: `${formatCount(t.realised.knownCount)} sold`,
        note: null,
        tone: null
      });
    }

    return tiles;
  });

  /**
   * The melt tile's footnote.
   *
   * A melt figure can be missing for two completely different reasons that
   * call for opposite reactions — the same distinction `describeMeltValue`
   * draws for a single grid cell. An empty price table is two clicks from
   * being fixed; a tray of clad quarters is not a fault at all. Saying only
   * "not recorded for 94 coins" would conflate them.
   */
  private meltNote(knownCount: number, coinCount: number): string | null {
    if (coinCount === 0) return null;
    if (!this.inv.hasSpotPrices()) {
      return 'No spot prices are loaded — open Spot Prices and press "Fetch COMEX Prices".';
    }
    const missing = coinCount - knownCount;
    if (missing <= 0) return null;
    return `No melt value for ${this.coinWord(missing)} of ${formatCount(coinCount)} — no PM weight, or not a priced metal.`;
  }

  // --- Precious metal held ---

  protected readonly metalTiles = computed<StatTile[]>(() =>
    this.holdings().holdings.map(holding => {
      const coinsOfMetal = holding.coinsWithWeight + holding.coinsMissingWeight;
      return {
        label: `${holding.metal} held`,
        value: formatGrams(holding.pureGrams),
        detail: holding.pureGrams === null ? null : formatTroyOunces(holding.pureGrams),
        note: coverageNote(
          holding.coinsWithWeight,
          coinsOfMetal,
          `${holding.metal.toLowerCase()} coins`
        ),
        tone: null
      };
    })
  );

  protected readonly metalNotes = computed<string[]>(() => {
    const { unpricedMetalCoinCount, noMetalCoinCount } = this.holdings();
    const notes: string[] = [];

    if (unpricedMetalCoinCount > 0) {
      notes.push(
        `${this.coinWord(unpricedMetalCoinCount)} ${this.beVerb(unpricedMetalCoinCount)} made of a metal ` +
          `the app holds no spot price for (palladium, bronze, clad and so on), so they count ` +
          `towards no holding and have no melt value.`
      );
    }
    if (noMetalCoinCount > 0) {
      notes.push(
        `${this.coinWord(noMetalCoinCount)} ${this.verb(noMetalCoinCount)} no Metal Content recorded.`
      );
    }
    return notes;
  });

  // --- The composition chart ---

  protected readonly dimensionLabel = computed(
    () => this.dimensionOptions.find(o => o.key === this.dimension())?.label ?? ''
  );

  protected readonly barChart = computed(() => {
    const metric = this.metric();
    const items = this.breakdown().slices.map(slice => ({
      label: slice.label,
      // Under the VALUE metric an unappraised slice measures 0 and draws no
      // bar at all — which is right: the chart genuinely cannot say how big
      // it is. Its coin count is still in the readout and its name still on
      // the axis, so it does not disappear.
      value: metric === 'count' ? slice.count : slice.value ?? 0,
      valueText: metric === 'count' ? formatCount(slice.count) : formatStatMoney(slice.value)
    }));

    return layoutRankedBars(items, {
      width: BAR_CHART.width,
      labelWidth: BAR_CHART.labelWidth,
      valueWidth: BAR_CHART.valueWidth,
      rowHeight: BAR_CHART.rowHeight,
      barThickness: BAR_CHART.barThickness,
      valueFontSize: LABEL_FONT_SIZE
    });
  });

  /** Category names, pre-truncated to the gutter — SVG has no text-overflow. */
  protected readonly barLabels = computed(() =>
    this.barChart().bars.map(bar => ({
      text: truncateLabel(bar.label, BAR_CHART.labelWidth - 12, LABEL_FONT_SIZE),
      full: bar.label,
      y: bar.centerY
    }))
  );

  protected readonly breakdownNote = computed(() =>
    coverageNote(this.breakdown().labelledCount, this.totals().coinCount)
  );

  protected readonly otherNote = computed(() => {
    const other = this.breakdown().slices.find(slice => slice.folded);
    if (!other) return null;
    return `"Other" combines ${other.foldedSliceCount} further ${this.dimensionLabel().toLowerCase()} values.`;
  });

  /**
   * The hover/focus readout for the composition chart.
   *
   * A tooltip ENHANCES, it never gates: every bar already carries its name
   * and (where it fits) its value, and this line adds what the bar could not
   * hold — above all how much of the slice has no value recorded, the one
   * thing a bar length cannot express.
   *
   * Rendered as a live region rather than a floating box so keyboard focus
   * announces exactly what hover shows.
   */
  protected readonly barReadout = computed(() => {
    const index = this.hoveredBar();
    if (index === null) return null;

    const slice = this.breakdown().slices[index];
    if (!slice) return null;

    const parts = [
      slice.label,
      `${this.coinWord(slice.count)}`,
      formatStatMoney(slice.value)
    ];
    let text = parts.join(' — ');
    if (slice.valueUnknownCount > 0) {
      text += ` (value recorded for ${slice.valueKnownCount} of ${slice.count})`;
    }
    return text;
  });

  protected readonly activeBarIndex = computed(() => this.hoveredBar());

  /** So the template can spot the folded bar without hard-coding the word. */
  protected readonly otherLabel = OTHER_LABEL;

  protected setDimension(dimension: BreakdownDimension): void {
    this.dimension.set(dimension);
    // The old index would point at a different category after a re-rank.
    this.hoveredBar.set(null);
  }

  protected setMetric(metric: BreakdownMetric): void {
    this.metric.set(metric);
    this.hoveredBar.set(null);
  }

  protected onBarFocus(index: number): void {
    this.hoveredBar.set(index);
  }

  protected onBarBlur(): void {
    this.hoveredBar.set(null);
  }

  // --- The cumulative-spend chart ---

  protected readonly hasSpendCurve = computed(() => this.spend().points.length > 0);

  protected readonly spendChart = computed(() =>
    layoutLineChart(
      this.spend().points.map(point => ({ x: point.time, y: point.cumulativeSpend })),
      SPEND_CHART
    )
  );

  protected readonly spendYLabels = computed(() =>
    this.spendChart().yTicks.map(tick => ({ y: tick.y, text: formatAxisTick(tick.value) }))
  );

  protected readonly spendXLabels = computed(() =>
    this.spendChart().xTicks.map(tick => ({ x: tick.x, text: formatChartMonth(tick.value) }))
  );

  /**
   * The single direct label on the curve: the total, at the end of the line.
   * The axis, the crosshair and the table twin carry the rest.
   */
  protected readonly spendEndLabel = computed(() => {
    const points = this.spendChart().points;
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    return { x: last.x, y: last.y, text: formatStatMoney(last.dataY) };
  });

  protected readonly activeSpendPoint = computed(() => {
    const index = this.crosshair();
    if (index === null) return null;
    return this.spend().points[index] ?? null;
  });

  /** Where to draw the crosshair hairline, or null when it is not showing. */
  protected readonly crosshairX = computed(() => {
    const index = this.crosshair();
    if (index === null) return null;
    return this.spendChart().points[index]?.x ?? null;
  });

  protected readonly activeSpendReadout = computed(() => {
    const point = this.activeSpendPoint();
    if (!point) return null;
    return (
      `${formatChartDay(point.time)} — ${formatStatMoney(point.cumulativeSpend)} spent ` +
      `across ${this.coinWord(point.cumulativeCoins)}`
    );
  });

  /**
   * The table twin. Every value on the curve is reachable here without a
   * pointer, which is what makes the tooltip an enhancement rather than the
   * only way to read the chart.
   */
  protected readonly spendTableRows = computed(() =>
    this.spend().points.map(point => ({
      date: formatChartDay(point.time),
      coins: formatCount(point.coins),
      spend: formatStatMoney(point.spend),
      cumulative: formatStatMoney(point.cumulativeSpend)
    }))
  );

  protected readonly spendNotes = computed<string[]>(() => {
    const series = this.spend();
    const notes: string[] = [];

    if (series.undatedCoinCount > 0) {
      notes.push(
        series.undatedSpend > 0
          ? `${this.coinWord(series.undatedCoinCount)} ${this.verb(series.undatedCoinCount)} no purchase ` +
              `date, so ${formatStatMoney(series.undatedSpend)} of spend is missing from this curve.`
          : `${this.coinWord(series.undatedCoinCount)} ${this.verb(series.undatedCoinCount)} no purchase ` +
              `date and no recorded price, so ${series.undatedCoinCount === 1 ? 'it is' : 'they are'} not on this curve.`
      );
    }

    if (series.datedButUnpricedCount > 0) {
      notes.push(
        `${this.coinWord(series.datedButUnpricedCount)} on the curve ${this.verb(series.datedButUnpricedCount)} ` +
          `no purchase price recorded, so ${series.datedButUnpricedCount === 1 ? 'it adds' : 'they add'} ` +
          `a coin but no money.`
      );
    }

    return notes;
  });

  protected readonly valueHistoryNote = computed(() => VALUE_HISTORY_NOTE);

  protected toggleSpendTable(): void {
    this.showSpendTable.set(!this.showSpendTable());
  }

  /**
   * The crosshair follows the pointer anywhere over the plot and snaps to the
   * nearest point: the reader aims at a DATE, never at a 2px line.
   *
   * `offsetX` is a user-unit x because the SVG has a fixed pixel width and no
   * viewBox scaling — see the class header.
   */
  protected onPlotMove(event: PointerEvent): void {
    const index = nearestPointIndex(this.spendChart().points, event.offsetX);
    this.crosshair.set(index === -1 ? null : index);
  }

  protected onPlotLeave(): void {
    this.crosshair.set(null);
  }

  /** The same readout, reachable from the keyboard. */
  protected onPlotKey(event: KeyboardEvent): void {
    const count = this.spendChart().points.length;
    if (count === 0) return;

    const current = this.crosshair();
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        this.crosshair.set(current === null ? 0 : Math.min(current + 1, count - 1));
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.crosshair.set(current === null ? count - 1 : Math.max(current - 1, 0));
        break;
      case 'Home':
        event.preventDefault();
        this.crosshair.set(0);
        break;
      case 'End':
        event.preventDefault();
        this.crosshair.set(count - 1);
        break;
      case 'Escape':
        this.crosshair.set(null);
        break;
      default:
        break;
    }
  }

  // --- Plumbing ---

  /** "1 coin" / "125 coins". Used everywhere a count is spoken, not shown. */
  private coinWord(count: number): string {
    return count === 1 ? '1 coin' : `${formatCount(count)} coins`;
  }

  /** The verb that agrees with coinWord(): "1 coin has" / "3 coins have". */
  private verb(count: number): string {
    return count === 1 ? 'has' : 'have';
  }

  /** As above, for "is/are": "1 coin is made of" / "3 coins are made of". */
  private beVerb(count: number): string {
    return count === 1 ? 'is' : 'are';
  }

  protected close(): void {
    this.closed.emit();
  }
}
