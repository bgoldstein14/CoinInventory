 /*
  * Decides whether a date-ish column holds coin years or calendar dates.
  *
  * header-synonyms.ts maps a `Date` heading to `year` (a coin's date is its
  * year). That is right for `1881`, `1909-S`, but wrong for `3/15/2024`, which
  * would write "2024" into Year. The heading can't tell them apart; the values can.
  *
  * - A cell typed as a date by the spreadsheet (`typedDate`, from
  *   read-excel-file) is always a full date. CSVs have no types, so text
  *   patterns decide there.
  * - Coin years include more than four digits:
  *     1909-S      year with mint mark
  *     1916-1945   a type's span
  *     -480, 44 BC BC dates
  *     476         ancient (three digits or fewer)
  *     c. 1880     hedged date
  *     1880s       decade
  *   Plausible range: 3000 BC to next year.
  * - `2024-03-15` starts with a year, so components are counted: three means
  *   a calendar date; two is a span only if it runs forwards.
  *
  * Sampling (runs on the interactive mapping path):
  *   COLUMN_SAMPLE_SIZE = 20 non-blank values, enough to sort a column into two buckets.
  *   COLUMN_SCAN_ROWS = 200 rows searched, to get past spacer rows and blank first cells.
  *   COIN_YEAR_MAJORITY = 0.8 must be coin years (tolerates junk like `?`), but a
  *   single recognisable full date vetoes `coin-year`.
  */

/**
 * One cell as the classifier sees it: `text` is what the importer will write
 * (flattened by xlsx/workbook-cell-text.ts, or the raw CSV field); `typedDate`
 * is the cell type that flattening loses.
 */
export interface ColumnCellSample {
  /** The cell's text; `''` when blank. */
  text: string;
  /** True only when the source typed the cell as a date (never for CSV). */
  typedDate?: boolean;
}

/**
 * Sampled cells per column, keyed by header text exactly as in the file (the
 * same key `mapHeadersToFields` returns), which also lets worksheets pool evidence.
 */
export type ColumnValueEvidence = Readonly<Record<string, readonly ColumnCellSample[]>>;

/** What one cell looks like. */
export type CellValueShape = 'coin-year' | 'full-date' | 'other' | 'blank';

/**
 * What a whole column looks like. `no-evidence` (nothing to go on; the
 * heading may decide) differs from `mixed` (don't guess).
 */
export type ColumnValueShape = 'coin-year' | 'full-date' | 'mixed' | 'no-evidence';

/** Non-blank values read before judging a column. */
export const COLUMN_SAMPLE_SIZE = 20;

/** How far down the column to search for those values. */
export const COLUMN_SCAN_ROWS = 200;

/** Share of sampled values that must be coin years to claim the column. */
export const COIN_YEAR_MAJORITY = 0.8;

/** Earliest BC year treated as plausible, as a positive number. */
const EARLIEST_BC_YEAR = 3000;

/** Latest plausible coin year: this year plus one (mints strike next year's coins early). */
function latestCoinYear(): number {
  return new Date().getUTCFullYear() + 1;
}

function isPlausibleCoinYear(value: number): boolean {
  if (!Number.isFinite(value) || value === 0) return false;
  if (value < 0) return -value <= EARLIEST_BC_YEAR;
  return value <= latestCoinYear();
}

/** A trailing clock time, so `2024-03-15T00:00:00Z` reduces to its date. */
const TRAILING_TIME = /[t ]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i;

/** `c.`, `ca`, `circa`, `~`: a hedged date. */
const CIRCA_PREFIX = /^(?:c|ca|circa|approx)\.?\s+|^[~]\s*/i;

/** A month written in words; no coin is dated "March". */
const MONTH_NAME =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/** An era marker, which only appears on coin dates. */
const ERA_DATE = /^(?:ad\s*)?(\d{1,4})\s*(bc|bce|ad|ce)?$/i;

/**
 * Three numeric components means a day is present: a calendar date. Covers
 * `3/15/2024`, `2024-03-15`, `15.03.2024`, `2024/3/5`.
 */
const THREE_PART_DATE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;

/** `1909-S`, `1883-CC`, `1922 D`: a year with its mint mark. */
const YEAR_WITH_MINT_MARK = /^(\d{1,4})(?:\s*[-–—/]\s*|\s+)([a-z]{1,3})$/i;

/** Two numeric components: a span of years or a truncated date. */
const TWO_PART_NUMERIC = /^(\d{1,4})\s*[-–—/]\s*(\d{1,4})$/;

/** `1881`, `-480`, `1880s`. */
const BARE_YEAR = /^(-?\d{1,4})s?$/;

/**
 * Whether `end` follows `start`, reading a two-digit tail as a collector would:
 * `1916-45` is 1916 to 1945; `2024-03` runs backwards, so it isn't a span.
 */
function isForwardYearSpan(startText: string, endText: string): boolean {
  const start = Number(startText);
  if (startText.length < 3 || !isPlausibleCoinYear(start)) return false;

  const end = endText.length >= 3
    ? Number(endText)
    : start - (start % 100) + Number(endText);

  return isPlausibleCoinYear(end) && end > start;
}

/**
 * Classifies one cell. Order matters: the cell type first, then era markers
 * and month names, then three components before two (so `2024-03-15` is never
 * read as a span).
 */
export function classifyCellValue(sample: ColumnCellSample): CellValueShape {
  if (sample.typedDate) return 'full-date';

  const trimmed = (sample.text ?? '').trim();
  if (!trimmed) return 'blank';

  const cleaned = trimmed
    .replace(TRAILING_TIME, '')
    .replace(CIRCA_PREFIX, '')
    // A trailing `?` is a hedge: `1881?` is still a year.
    .replace(/\?+$/, '')
    .trim();
  if (!cleaned) return 'blank';

  if (MONTH_NAME.test(cleaned)) return 'full-date';

  // `44 BC`, `44 B.C.`, `AD 117`, `117 CE`. Periods are removed first so the
  // abbreviation isn't mistaken for a dotted date.
  const eraCandidate = cleaned.replace(/\./g, '').replace(/\s+/g, ' ');
  const era = ERA_DATE.exec(eraCandidate);
  if (era && (era[2] || /^ad\s/i.test(eraCandidate))) {
    const magnitude = Number(era[1]);
    const isBc = /^bce?$/i.test(era[2] ?? '');
    return isPlausibleCoinYear(isBc ? -magnitude : magnitude) ? 'coin-year' : 'other';
  }

  if (THREE_PART_DATE.test(cleaned)) return 'full-date';

  const mintMarked = YEAR_WITH_MINT_MARK.exec(cleaned);
  if (mintMarked) {
    return isPlausibleCoinYear(Number(mintMarked[1])) ? 'coin-year' : 'other';
  }

  const twoPart = TWO_PART_NUMERIC.exec(cleaned);
  if (twoPart) {
    if (isForwardYearSpan(twoPart[1], twoPart[2])) return 'coin-year';
    // Not a span: `2024-03` or `3/15` is a calendar value with a part missing.
    return 'full-date';
  }

  const bare = BARE_YEAR.exec(cleaned);
  if (bare) return isPlausibleCoinYear(Number(bare[1])) ? 'coin-year' : 'other';

  return 'other';
}

/**
 * Judges a column from its samples. `coin-year` needs a strong majority and no
 * full date at all; anything else leaves the mapping to the user.
 */
export function classifyColumnValues(samples: readonly ColumnCellSample[]): ColumnValueShape {
  let years = 0;
  let dates = 0;
  let total = 0;

  for (const sample of samples) {
    const shape = classifyCellValue(sample);
    if (shape === 'blank') continue;
    total += 1;
    if (shape === 'coin-year') years += 1;
    else if (shape === 'full-date') dates += 1;
  }

  if (total === 0) return 'no-evidence';
  if (dates === 0 && years / total >= COIN_YEAR_MAJORITY) return 'coin-year';
  if (years === 0 && dates / total >= COIN_YEAR_MAJORITY) return 'full-date';
  return 'mixed';
}

/**
 * The first COLUMN_SAMPLE_SIZE non-blank cells, looking no further than
 * COLUMN_SCAN_ROWS down. Blanks are skipped so leading spacer rows don't hide the data.
 */
export function sampleColumnCells(
  cells: readonly ColumnCellSample[]
): ColumnCellSample[] {
  const sampled: ColumnCellSample[] = [];
  const limit = Math.min(cells.length, COLUMN_SCAN_ROWS);

  for (let index = 0; index < limit && sampled.length < COLUMN_SAMPLE_SIZE; index++) {
    const cell = cells[index];
    if (cell && cell.text && cell.text.trim()) sampled.push(cell);
  }

  return sampled;
}

/** Sample and classify in one step, for a caller holding a whole column. */
export function shapeOfColumn(cells: readonly ColumnCellSample[]): ColumnValueShape {
  return classifyColumnValues(sampleColumnCells(cells));
}

/**
 * Builds evidence from plain text rows (the CSV path). A row shorter than the
 * headers reads missing cells as blank.
 */
export function textColumnSamples(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): Record<string, ColumnCellSample[]> {
  const scanned = rows.slice(0, COLUMN_SCAN_ROWS);
  const samples: Record<string, ColumnCellSample[]> = {};

  headers.forEach((header, index) => {
    // First occurrence wins, as in mapHeadersToFields.
    if (samples[header] !== undefined) return;
    samples[header] = sampleColumnCells(
      scanned.map(row => ({ text: row[index] ?? '' }))
    );
  });

  return samples;
}

/**
 * Pools evidence from several sources. One mapping covers every ticked
 * worksheet (csv/import-plan.ts), so the decision uses all their values;
 * disagreeing tabs come out `mixed`. Capped at COLUMN_SAMPLE_SIZE per header.
 */
export function mergeColumnSamples(
  sources: readonly ColumnValueEvidence[]
): Record<string, ColumnCellSample[]> {
  const pooled = new Map<string, ColumnCellSample[]>();

  for (const source of sources) {
    for (const [header, cells] of Object.entries(source)) {
      const existing = pooled.get(header);
      if (existing) existing.push(...cells);
      else pooled.set(header, [...cells]);
    }
  }

  const merged: Record<string, ColumnCellSample[]> = {};
  for (const [header, cells] of pooled) {
    merged[header] = cells.slice(0, COLUMN_SAMPLE_SIZE);
  }
  return merged;
}
