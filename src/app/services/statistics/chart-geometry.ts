 /*
 * chart-geometry.ts — every number that ends up inside an SVG attribute.
 * ---- WHY THE CHARTS ARE HAND-ROLLED SVG AND NOT A LIBRARY ----
 * 1. THE BUNDLE. The production build is 752 kB initial against a 500 kB
 *    warning and a 1 MB HARD ERROR budget (angular.json). Chart.js is ~200 kB
 *    minified, ECharts ~1 MB, and the d3 modules needed for scales and shapes
 *    are ~60 kB. The first two breach the error budget on their own; all
 *    three would have to be lazy-loaded behind `await import(...)` like
 *    read-excel-file already is, which means a spinner on a dialog that
 *    otherwise opens instantly. Bar, line and donut geometry is a few dozen
 *    lines of arithmetic. It is not worth 200 kB.
 *
 * 2. THE TESTS. This project's frontend suite runs under Node with NO jsdom.
 *    Nothing renders, nothing can be screenshotted, `getBoundingClientRect`
 *    does not exist. A library-backed chart would be untestable here — the
 *    only assertion available would be "we called the library". Pulling the
 *    geometry out as pure functions over numbers makes the chart testable to
 *    the pixel with no DOM at all, which is why this file exists separately
 *    from the component that draws with it.
 *
 * ---- THE MARK RULES ENCODED HERE (from the project's data-viz guidance) ----
 *   - bars no thicker than 24px, never filling their row; the leftover is air
 *   - a >= 2px gap, in the surface colour, between neighbouring bars — the gap
 *     is what separates them, never a stroke drawn around them
 *   - a 4px rounded data-END, SQUARE at the baseline, so the bar visibly
 *     grows from the axis
 *   - a zero draws NOTHING: a 1px sliver reads as a small value
 *   - a value label is never clipped by its own bar. Outside the tip if it
 *     fits, inside the bar end if it fits there, otherwise not drawn — the
 *     hover tooltip is its overflow home. `overflow: hidden` cropping the
 *     first characters of a label is worse than having no label.
 *   - hit targets are bigger than the marks (>= 24px), because a 14px row is
 *     a pinpoint nobody lands on
  */

/** Bars never exceed this, however tall their row. */
export const MAX_BAR_THICKNESS = 24;

/** The gap, in the surface colour, that separates neighbouring bars. */
export const BAR_GAP = 2;

/** The rounding on a bar's data-end. The baseline end stays square. */
export const BAR_END_RADIUS = 4;

/** A pointer target smaller than this is a pinpoint. */
export const MIN_HIT_SIZE = 24;

/** Breathing room between a bar's tip and its value label. */
const VALUE_PADDING = 6;

/** Default size of the value text, used to work out whether it fits. */
const DEFAULT_VALUE_FONT_SIZE = 11;

/** Two decimal places, and no "-0". Keeps float noise out of the markup. */
function r2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Roughly how wide some text will render.
 *
 * An ESTIMATE, and it has to be: there is no DOM here to measure against, in
 * the app (where the chart is built before layout) or in the tests (where
 * there is no DOM at all). 0.6em per character is the usual approximation for
 * a UI sans at small sizes and errs slightly wide, which is the safe
 * direction — it drops a borderline label rather than clipping it.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

/**
 * Shorten a label to fit a gutter, marking the cut with a single ellipsis.
 *
 * Returning a cut string rather than relying on CSS `text-overflow` because
 * SVG `<text>` does not support it; the alternatives are a `<foreignObject>`
 * or letting the name run across the chart.
 */
export function truncateLabel(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;

  const charWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidth / charWidth);
  if (maxChars <= 1) return '';

  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * The outline of a horizontal bar: square at the baseline (left), rounded at
 * the data-end (right).
 *
 * Returns an EMPTY path for a zero or negative width. A bar of zero must
 * leave no ink at all — a hairline where a category has no value is read as a
 * small value, which is exactly the class of silent wrongness this whole
 * feature is trying to avoid.
 */
export function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number = BAR_END_RADIUS
): string {
  if (width <= 0 || height <= 0) return '';

  const r = r2(Math.min(radius, width, height / 2));
  const x0 = r2(x);
  const y0 = r2(y);
  const x1 = r2(x + width);
  const y1 = r2(y + height);

  if (r <= 0) return `M ${x0} ${y0} H ${x1} V ${y1} H ${x0} Z`;

  return (
    `M ${x0} ${y0} ` +
    `H ${r2(x1 - r)} A ${r} ${r} 0 0 1 ${x1} ${r2(y0 + r)} ` +
    `V ${r2(y1 - r)} A ${r} ${r} 0 0 1 ${r2(x1 - r)} ${y1} ` +
    `H ${x0} Z`
  );
}

export interface RankedBarItem {
  label: string;
  value: number;
  /** Already formatted by the caller — geometry only measures it. */
  valueText: string;
}

export interface RankedBarOptions {
  /** Total SVG width. */
  width: number;
  /** Left gutter holding the category names. */
  labelWidth: number;
  /** Right gutter reserved for the value at the tip. */
  valueWidth: number;
  /** Pitch from one bar to the next. */
  rowHeight: number;
  /** Requested bar thickness; capped at MAX_BAR_THICKNESS and by the row. */
  barThickness?: number;
  valueFontSize?: number;
}

export interface RankedBar {
  label: string;
  value: number;
  valueText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The `d` attribute. Empty string when the value is zero. */
  path: string;
  /** Vertical centre, for the category and value text baselines. */
  centerY: number;
  /** False when the value text fits in neither place — see the header. */
  valueVisible: boolean;
  valueInside: boolean;
  valueAnchor: 'start' | 'end';
  valueX: number;
  /** The full-width, >= 24px pointer/focus target for this row. */
  hitX: number;
  hitY: number;
  hitWidth: number;
  hitHeight: number;
}

export interface RankedBarChart {
  bars: RankedBar[];
  /** The largest value, which gets the full plot width. 0 if all are zero. */
  max: number;
  plotLeft: number;
  plotWidth: number;
  width: number;
  height: number;
}

/**
 * Lay out a ranked horizontal bar chart.
 *
 * Horizontal rather than vertical because the categories are
 * long-named ("Standing Liberty Quarter", "United States") and a column chart
 * would have to rotate them; ranked bars on one shared baseline also compare
 * far more exactly than the pie or donut a part-to-whole request usually
 * reaches for.
 *
 * One hue for every bar. The categories (denominations, countries, grades)
 * have no natural order, so shading each bar darker-where-bigger would
 * double-encode length as colour, spend the only free channel on information
 * the bar length already carries, and make a nominal scale look ordered.
 */
export function layoutRankedBars(
  items: readonly RankedBarItem[],
  options: RankedBarOptions
): RankedBarChart {
  const { width, labelWidth, valueWidth, rowHeight } = options;
  const valueFontSize = options.valueFontSize ?? DEFAULT_VALUE_FONT_SIZE;

  const plotLeft = labelWidth;
  const plotWidth = Math.max(0, width - labelWidth - valueWidth);

  // Not `|| 1`. If every value is zero, every bar must be zero-width: a fall
  // back to a divisor of 1 would draw every bar at full width and say "all
  // equal, all large" about a collection where nothing is known.
  const max = items.reduce((m, item) => Math.max(m, item.value), 0);

  const requested = options.barThickness ?? 18;
  const height = Math.max(1, Math.min(requested, MAX_BAR_THICKNESS, rowHeight - BAR_GAP));

  const bars: RankedBar[] = items.map((item, index) => {
    const barWidth = max > 0 ? (Math.max(0, item.value) / max) * plotWidth : 0;
    const rowTop = index * rowHeight;
    const y = rowTop + (rowHeight - height) / 2;
    const tip = plotLeft + barWidth;

    const needed = estimateTextWidth(item.valueText, valueFontSize) + VALUE_PADDING;
    const fitsOutside = width - tip >= needed;
    const fitsInside = barWidth >= needed;

    // Hit target: the whole row, at least MIN_HIT_SIZE tall, centred on the
    // bar. Deliberately the full chart width so the category name and the
    // empty track to the right of a short bar are part of the target too.
    const hitHeight = Math.max(rowHeight, MIN_HIT_SIZE);

    return {
      label: item.label,
      value: item.value,
      valueText: item.valueText,
      x: plotLeft,
      y,
      width: barWidth,
      height,
      path: barPath(plotLeft, y, barWidth, height),
      centerY: y + height / 2,
      valueVisible: fitsOutside || fitsInside,
      valueInside: !fitsOutside && fitsInside,
      valueAnchor: fitsOutside ? 'start' : 'end',
      valueX: fitsOutside ? tip + VALUE_PADDING : tip - VALUE_PADDING,
      hitX: 0,
      hitY: rowTop + rowHeight / 2 - hitHeight / 2,
      hitWidth: width,
      hitHeight
    };
  });

  return {
    bars,
    max,
    plotLeft,
    plotWidth,
    width,
    height: items.length * rowHeight
  };
}

/**
 * Axis ticks on round numbers that span the data.
 *
 * The textbook "nice numbers" algorithm: snap the range and the step to the
 * nearest 1, 2 or 5 times a power of ten. Ticks are re-rounded to twelve
 * significant figures on the way out because repeated addition of a step like
 * 0.2 otherwise puts `0.30000000000000004` on the axis.
 */
export function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return [min, min + 1];
  }

  const range = niceNumber(max - min, false);
  const step = niceNumber(range / Math.max(1, targetCount - 1), true);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;

  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

function niceNumber(range: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);

  let nice: number;
  if (round) {
    nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  } else {
    nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  }
  return nice * Math.pow(10, exponent);
}

export interface SeriesPoint {
  x: number;
  y: number;
}

export interface PlottedPoint {
  index: number;
  /** Pixel position inside the SVG. */
  x: number;
  y: number;
  /** The original values, carried through for the tooltip. */
  dataX: number;
  dataY: number;
}

export interface LineChartOptions {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
  /** How many y gridlines to aim for. */
  tickCount?: number;
  /** How many x labels to aim for. */
  xTickCount?: number;
}

export interface LineChartLayout {
  points: PlottedPoint[];
  /** The `d` for the 2px stroke. Empty for an empty series. */
  linePath: string;
  /** The same shape closed down to the baseline, for the 10% wash. */
  areaPath: string;
  yTicks: { value: number; y: number }[];
  xTicks: { value: number; x: number }[];
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  yMax: number;
}

/**
 * Lay out a single-series line chart on a time axis.
 *
 * The y scale ALWAYS starts at zero. This is a money curve: a scale that
 * started at the first value would exaggerate every subsequent rise, which is
 * the oldest trick in the chart book and is not one this app plays.
 *
 * A single data point is centred rather than divided by a zero x-range. One
 * purchase is a perfectly ordinary state for a new collection and must not
 * produce NaN in a `d=` attribute (which silently renders nothing).
 */
export function layoutLineChart(
  series: readonly SeriesPoint[],
  options: LineChartOptions
): LineChartLayout {
  const { width, height, padLeft, padRight, padTop, padBottom } = options;
  const plotLeft = padLeft;
  const plotRight = width - padRight;
  const plotTop = padTop;
  const plotBottom = height - padBottom;

  const empty: LineChartLayout = {
    points: [],
    linePath: '',
    areaPath: '',
    yTicks: [],
    xTicks: [],
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax: 0
  };
  if (series.length === 0) return empty;

  const xMin = Math.min(...series.map(p => p.x));
  const xMax = Math.max(...series.map(p => p.x));
  const yPeak = Math.max(0, ...series.map(p => p.y));

  const yTickValues = niceTicks(0, yPeak, options.tickCount ?? 4);
  const yMax = yTickValues[yTickValues.length - 1];

  const xSpan = xMax - xMin;
  const scaleX = (value: number): number =>
    xSpan === 0 ? (plotLeft + plotRight) / 2 : plotLeft + ((value - xMin) / xSpan) * (plotRight - plotLeft);
  const scaleY = (value: number): number =>
    yMax === 0 ? plotBottom : plotBottom - (value / yMax) * (plotBottom - plotTop);

  const points: PlottedPoint[] = series.map((point, index) => ({
    index,
    x: r2(scaleX(point.x)),
    y: r2(scaleY(point.y)),
    dataX: point.x,
    dataY: point.y
  }));

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');

  // The wash under the line: the same outline, dropped to the baseline and
  // closed. Drawn as its own path rather than as a filled line so the stroke
  // can keep its round joins without the fill leaking round them.
  const areaPath = `${linePath} V ${plotBottom} H ${points[0].x} Z`;

  const yTicks = yTickValues.map(value => ({ value, y: r2(scaleY(value)) }));

  // X ticks are evenly spaced across the real range and always include both
  // ends, so the axis cannot imply the series starts or stops somewhere it
  // does not. A single point gets exactly one tick rather than a crowd of
  // identical dates.
  const xTickCount = Math.max(1, Math.min(options.xTickCount ?? 4, series.length));
  const xTicks =
    xSpan === 0 || xTickCount === 1
      ? [{ value: xMin, x: r2(scaleX(xMin)) }]
      : Array.from({ length: xTickCount }, (_, i) => {
          const value = xMin + (xSpan * i) / (xTickCount - 1);
          return { value, x: r2(scaleX(value)) };
        });

  return {
    points,
    linePath,
    areaPath,
    yTicks,
    xTicks,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax
  };
}

/**
 * The point nearest a pointer x, for the crosshair.
 *
 * The reader aims at a DATE, never at a 2px line — so the whole plot is a hit
 * surface and the crosshair snaps to whichever point is closest, clamping at
 * both ends rather than losing the readout off the edge.
 *
 * Returns -1 for an empty series so the caller can show nothing.
 */
export function nearestPointIndex(points: readonly PlottedPoint[], x: number): number {
  if (points.length === 0) return -1;

  let bestIndex = 0;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(point.x - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = point.index;
    }
  }
  return bestIndex;
}
