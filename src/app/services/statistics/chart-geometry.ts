 /*
  * Pure geometry for the statistics charts (hand-rolled SVG). Kept as pure
  * functions so charts are testable under Node without a DOM, and to avoid a
  * charting library's bundle cost.
  *
  * Mark rules:
  *   - bars at most 24px thick, separated by a >= 2px surface-coloured gap
  *   - a 4px rounded data-end, square at the baseline
  *   - a zero draws nothing (a 1px sliver reads as a small value)
  *   - a value label is drawn outside the tip if it fits, inside the bar end if
  *     it fits there, otherwise not at all (the tooltip shows it); never clipped
  *   - hit targets at least 24px
  */

/** Bars never exceed this, however tall their row. */
export const MAX_BAR_THICKNESS = 24;

/** Gap between neighbouring bars, in the surface colour. */
export const BAR_GAP = 2;

/** Rounding on a bar's data-end; the baseline end stays square. */
export const BAR_END_RADIUS = 4;

/** Minimum pointer target size. */
export const MIN_HIT_SIZE = 24;

/** Space between a bar's tip and its value label. */
const VALUE_PADDING = 6;

/** Default value text size, used to work out whether it fits. */
const DEFAULT_VALUE_FONT_SIZE = 11;

/** Two decimal places and no "-0", to keep float noise out of the markup. */
function r2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Estimated rendered text width (no DOM to measure). 0.6em per character errs
 * slightly wide, so a borderline label is dropped rather than clipped.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

/** Shortens a label to fit with an ellipsis (SVG `<text>` has no text-overflow). */
export function truncateLabel(text: string, maxWidth: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= maxWidth) return text;

  const charWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidth / charWidth);
  if (maxChars <= 1) return '';

  return `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Outline of a horizontal bar: square at the baseline (left), rounded at the
 * data-end (right). Empty for a zero or negative width.
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
  /** Pre-formatted by the caller; only measured here. */
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
  /** False when the value text fits in neither place. */
  valueVisible: boolean;
  valueInside: boolean;
  valueAnchor: 'start' | 'end';
  valueX: number;
  /** Full-width, >= 24px pointer/focus target for this row. */
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
 * Lays out a ranked horizontal bar chart (horizontal because category names
 * are long). One hue for every bar: the categories have no natural order.
 */
export function layoutRankedBars(
  items: readonly RankedBarItem[],
  options: RankedBarOptions
): RankedBarChart {
  const { width, labelWidth, valueWidth, rowHeight } = options;
  const valueFontSize = options.valueFontSize ?? DEFAULT_VALUE_FONT_SIZE;

  const plotLeft = labelWidth;
  const plotWidth = Math.max(0, width - labelWidth - valueWidth);

  // Not `|| 1`: if every value is zero, every bar must be zero-width.
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

    // Hit target: the whole row width, at least MIN_HIT_SIZE tall, centred on the bar.
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
 * Axis ticks on round numbers (1, 2 or 5 times a power of ten) spanning the
 * data. Rounded to 12 significant figures to remove float noise.
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
  /** The original values, for the tooltip. */
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
  /** The same shape closed down to the baseline, for the 10% fill. */
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
 * Lays out a single-series line chart on a time axis. The y scale always
 * starts at zero so rises aren't exaggerated. A single point is centred
 * (avoids NaN from a zero x-range).
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

  // Separate fill path so the stroke keeps its round joins.
  const areaPath = `${linePath} V ${plotBottom} H ${points[0].x} Z`;

  const yTicks = yTickValues.map(value => ({ value, y: r2(scaleY(value)) }));

  // X ticks are evenly spaced and include both ends; a single point gets one tick.
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
 * Index of the point nearest a pointer x, for the crosshair; the whole plot is
 * the hit area. Returns -1 for an empty series.
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
