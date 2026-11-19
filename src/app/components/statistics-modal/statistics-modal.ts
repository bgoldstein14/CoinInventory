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
 * The Statistics dialog. A thin renderer: figures come from pure modules in
 * services/statistics/ and SVG coordinates from chart-geometry.ts, so all the
 * arithmetic is testable without a DOM. Unknown figures are null and render
 * as "—" with a coverage note; they are never shown as zero.
 *
 * Charts are hand-drawn SVG (no charting library) with a fixed pixel width
 * and no viewBox scaling, so PointerEvent.offsetX equals the SVG x coordinate.
 */

/** Geometry of the composition chart. Fixed width; see the header. */
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

/** Always shown under the spend chart, to explain why there is no value-over-time line. */
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
   * Direction, for the gain/loss colouring. Colour is never the only cue: the
   * label and the +/- sign also change, for greyscale and colour-blind users.
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
   * Notice shown until the collection has loaded, so an empty inventory is not
   * reported as a collection worth $0.00.
   */
  protected readonly notReadyNotice = computed(() =>
    collectionNotReadyNotice({
      loaded: this.inv.connected(),
      failed: this.inv.connectionError() !== null
    })
  );

  // --- The numbers ---

  /** Statistics cover the whole collection, not the filtered grid. */
  private readonly coins = computed(() => this.inv.inventory());

  private readonly totals = computed(() =>
    computeCollectionTotals(this.coins(), this.inv.spotPrices())
  );

  private readonly holdings = computed(() => computePreciousMetalHoldings(this.coins()));

  /**
   * The ranked-bar chart's data. `undefined` keeps the module's default slice
   * cap; the denominations lookup labels bars the same way the grid does.
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

    // Shown only once something has been sold.
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
   * The melt tile's footnote. Distinguishes "no spot prices loaded" (fixable)
   * from coins that simply have no precious-metal weight.
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
      // An unappraised slice draws no bar under the value metric but keeps its label.
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
   * The hover/focus readout for the composition chart, including how much of
   * the slice has no value recorded. Rendered as a live region so keyboard
   * focus announces what hover shows.
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

  /** The total, labelled at the end of the line. */
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

  /** Table version of the spend curve, readable without a pointer. */
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
   * Snaps the crosshair to the point nearest the pointer. offsetX is usable as
   * an SVG x because the chart has a fixed width (see the header).
   */
  protected onPlotMove(event: PointerEvent): void {
    const index = nearestPointIndex(this.spendChart().points, event.offsetX);
    this.crosshair.set(index === -1 ? null : index);
  }

  protected onPlotLeave(): void {
    this.crosshair.set(null);
  }

  /** Keyboard navigation of the crosshair. */
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

  /** "1 coin" / "125 coins". */
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
