 /*
 * date-column-shape.ts — deciding what a date-ish column actually holds.
 * ---- WHY THIS FILE EXISTS ----
 * header-synonyms.ts maps a column headed `Date` onto `year`, because in
 * numismatic usage a coin's date IS its year -- it is the number struck on
 * the coin. For a sheet whose Date column reads `1881`, `1909-S`, `1873`
 * that is right, and it saves the user a dropdown on the one column they
 * would otherwise have to think about.
 *
 * The same heading over `3/15/2024` is not that at all. It is a calendar
 * date, and only the person who built the sheet knows which one -- when
 * they bought the coin, when they sold it, when they catalogued it, when it
 * was last appraised. Mapped onto Year it writes "2024" into the Year field
 * of a Morgan dollar, under a dropdown that already says "Year" and that
 * nobody re-reads. That is precisely the confident-wrong-mapping failure
 * header-synonyms.ts is built to refuse, arriving through the one synonym
 * in the table that is ambiguous about WHICH KIND of date it means.
 *
 * The heading cannot settle it. The values can, so this module reads them.
 *
 * ---- THE CELL TYPE IS THE STRONGEST SIGNAL, AND IT IS FREE ----
 * `read-excel-file` hands back a real `Date` object for any cell carrying a
 * date NUMBER FORMAT (see xlsx/workbook-cell-text.ts). A cell Excel itself
 * calls a date is a full date -- year, month and day -- always. It is never
 * a bare coin year, because a bare coin year in a spreadsheet is a number
 * or a string, not a formatted date.
 *
 * So where the type is known it decides on its own, and `typedDate` below
 * carries it. This matters most for the case text cannot help with: a
 * purchase date that happens to fall on 1 January renders as `1981-01-01`,
 * which is as year-like as a full date ever gets, and the type says "date"
 * without having to parse anything.
 *
 * A CSV has no types. There, and for a workbook whose dates were typed in
 * as text, the pattern below is all there is.
 *
 * ---- WHAT COUNTS AS A COIN YEAR IS WIDER THAN FOUR DIGITS ----
 * `CoinRecord.year` is a STRING, deliberately, because the collection holds
 * things a number cannot express. A rule that only accepted /^\d{4}$/ would
 * reject all of these and send perfectly good columns back to the user:
 *
 *     1909-S        a mint mark written onto the date, as collectors do
 *     1916-1945     a type's span, which is why the field is a string
 *     -480          a BC date, stored negative
 *     44 BC         the same thing spelled out
 *     476           an ancient coin; three digits, or fewer
 *     c. 1880       the hedge on an attributed but unproven date
 *     1880s         a decade
 *
 * The upper bound is this year plus one rather than a literal, so the rule
 * does not quietly start rejecting new coins in some future year that
 * nobody is around to fix. The lower bound is 1 AD / 3000 BC, which is
 * earlier than coinage itself.
 *
 * ---- THE TRAP THIS CODE EXISTS TO AVOID: `2024-03-15` STARTS WITH A YEAR ----
 * The obvious cheap test -- does the cell start with four digits? -- says
 * yes to every ISO date in the file. So does `parseInt`, which happily
 * returns 2024 from "2024-03-15". A date column written the ISO way would
 * then import as a column of years 2024, 2023, 2022, with no warning
 * anywhere. The classifier below counts SEPARATED COMPONENTS instead:
 * three means a day is present and it is a calendar date; two is read as a
 * range only when it runs forwards in time, which a year-and-month pair
 * never does.
 *
 * ---- WHY SAMPLE, AND WHY THESE NUMBERS ----
 * The mapping grid is redrawn every time the user ticks a worksheet, so
 * this runs on the interactive path and must not scan a 50,000-row export
 * column by column.
 *
 *   COLUMN_SAMPLE_SIZE = 20 non-blank values. A column is being sorted into
 *   two buckets. Twenty values settle that far beyond doubt -- a column
 *   that is even 10% calendar dates is caught with ~88% probability, and
 *   one that is half and half is a certainty -- while still being small
 *   enough that pooling it across a dozen worksheets costs nothing.
 *
 *   COLUMN_SCAN_ROWS = 200 rows looked at to find those twenty. Real
 *   collectors' sheets open with spacer rows, a group heading, or a first
 *   coin whose Date cell was never filled in, so reading "the first two
 *   rows" reads nothing and classifies the column as unknown. Two hundred
 *   rows is far more slack than any realistic run of blanks at the top of a
 *   sheet, and it bounds the work on a file of any size.
 *
 *   COIN_YEAR_MAJORITY = 0.8 of the sampled values must be coin years. Not
 *   all of them: one `?`, one `unknown`, one typo in a 500-row sheet should
 *   not blank a column that is plainly years. But a SINGLE recognisable
 *   full date vetoes it outright regardless of the majority -- see
 *   classifyColumnValues. Junk is noise; a real date is evidence that the
 *   column means something else.
  */

/**
 * One cell of a column, as the classifier sees it.
 *
 * `text` is what the importer will actually put into the field -- already
 * flattened by xlsx/workbook-cell-text.ts for a workbook, or the raw CSV
 * field. `typedDate` is the one thing that flattening destroys and that no
 * amount of looking at the text can recover with certainty.
 */
export interface ColumnCellSample {
  /** The cell's text. `''` for a blank cell. */
  text: string;
  /** True only when the SOURCE typed this cell as a date. CSV never does. */
  typedDate?: boolean;
}

/**
 * Sampled cells per column, keyed by the header text EXACTLY as it appears
 * in the file -- the same key `mapHeadersToFields` returns, so the two line
 * up without anyone having to track column indexes. Keying by text is also
 * what lets several worksheets pool their evidence for one shared heading.
 */
export type ColumnValueEvidence = Readonly<Record<string, readonly ColumnCellSample[]>>;

/** What one cell looks like. */
export type CellValueShape = 'coin-year' | 'full-date' | 'other' | 'blank';

/**
 * What a whole column looks like.
 *
 * `no-evidence` is NOT the same as `mixed`. A column with nothing in it
 * cannot put a wrong value anywhere, so the caller is free to fall back to
 * whatever the heading says; a column that is mixed or unreadable has told
 * us something, and what it told us is "do not guess".
 */
export type ColumnValueShape = 'coin-year' | 'full-date' | 'mixed' | 'no-evidence';

/** How many non-blank values are read before a column is judged. */
export const COLUMN_SAMPLE_SIZE = 20;

/** How far down the column the search for those values gives up. */
export const COLUMN_SCAN_ROWS = 200;

/** The share of sampled values that must be coin years to claim the column. */
export const COIN_YEAR_MAJORITY = 0.8;

/** Earliest BC year treated as plausible, as a positive magnitude. */
const EARLIEST_BC_YEAR = 3000;

/**
 * Latest plausible coin year: this year plus one, because mints strike
 * next year's coins late in the current one and because a hardcoded literal
 * is a bug with a delayed fuse.
 */
function latestCoinYear(): number {
  return new Date().getUTCFullYear() + 1;
}

/** Is this number a year a coin could carry? */
function isPlausibleCoinYear(value: number): boolean {
  if (!Number.isFinite(value) || value === 0) return false;
  if (value < 0) return -value <= EARLIEST_BC_YEAR;
  return value <= latestCoinYear();
}

/* --- The patterns, each with the thing it is there to catch ------------- */

/** A trailing clock time, so `2024-03-15T00:00:00Z` reduces to its date. */
const TRAILING_TIME = /[t ]\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:z|[+-]\d{2}:?\d{2})?$/i;

/** `c.`, `ca`, `circa`, `~` -- the hedge on an attributed date. */
const CIRCA_PREFIX = /^(?:c|ca|circa|approx)\.?\s+|^[~]\s*/i;

/** A month written in words. Nothing on a coin is dated "March". */
const MONTH_NAME =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

/** An era marker, which only ever appears on a coin date. */
const ERA_DATE = /^(?:ad\s*)?(\d{1,4})\s*(bc|bce|ad|ce)?$/i;

/**
 * Three numeric components: a day is present, so it is a calendar date.
 * Covers `3/15/2024`, `2024-03-15`, `15.03.2024` and `2024/3/5` in one go,
 * without having to know which component is the month.
 */
const THREE_PART_DATE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;

/** `1909-S`, `1883-CC`, `1922 D`: a date with its mint mark written on. */
const YEAR_WITH_MINT_MARK = /^(\d{1,4})(?:\s*[-–—/]\s*|\s+)([a-z]{1,3})$/i;

/** Two numeric components: either a span of years or a truncated date. */
const TWO_PART_NUMERIC = /^(\d{1,4})\s*[-–—/]\s*(\d{1,4})$/;

/** `1881`, `-480`, `1880s`. */
const BARE_YEAR = /^(-?\d{1,4})s?$/;

/**
 * Is `end` a year that follows `start`, reading a two-digit tail the way a
 * collector means it? `1916-45` is 1916 to 1945; `2024-03` is not 2024 to
 * 2003, which is why a pair that runs backwards is not a range.
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
 * Classify one cell.
 *
 * Order matters. The type beats everything; an era marker or a month name
 * settles the question before any numeric shape is considered; and the
 * three-component test runs before the two-component one so `2024-03-15`
 * can never be read as the span 2024-2015.
 */
export function classifyCellValue(sample: ColumnCellSample): CellValueShape {
  // A cell the spreadsheet itself formatted as a date is a full date, and
  // no rendering of it can change that. See the header.
  if (sample.typedDate) return 'full-date';

  const trimmed = (sample.text ?? '').trim();
  if (!trimmed) return 'blank';

  const cleaned = trimmed
    .replace(TRAILING_TIME, '')
    .replace(CIRCA_PREFIX, '')
    // A trailing `?` is the other hedge: `1881?` is still a year.
    .replace(/\?+$/, '')
    .trim();
  if (!cleaned) return 'blank';

  if (MONTH_NAME.test(cleaned)) return 'full-date';

  // `44 BC`, `44 B.C.`, `AD 117`, `117 CE`. The periods come out first so
  // the abbreviated spelling is not mistaken for a dotted date.
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
    // Not a span. `2024-03` and `3/15` are a calendar value with a
    // component left off -- still not a coin year, and still evidence that
    // this column is about the calendar.
    return 'full-date';
  }

  const bare = BARE_YEAR.exec(cleaned);
  if (bare) return isPlausibleCoinYear(Number(bare[1])) ? 'coin-year' : 'other';

  return 'other';
}

/**
 * Judge a whole column from its sampled cells.
 *
 * The asymmetry is the point. `coin-year` is a claim and needs a strong
 * majority AND no counter-evidence at all; everything else is a shrug,
 * which costs the user one dropdown. See the header for why one real date
 * vetoes a column that is otherwise all years: a stray `unknown` is noise,
 * but a `3/15/2024` sitting among the years means the column is not what
 * the heading suggests, or is not consistent enough to import blind.
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
 * Pick the cells worth judging a column by: the first COLUMN_SAMPLE_SIZE
 * non-blank ones, looking no further than COLUMN_SCAN_ROWS down.
 *
 * Skipping blanks rather than taking the first N cells verbatim is the
 * whole reason this is a function. A sheet that opens with a spacer row, a
 * group heading, or one coin whose Date was never filled in would otherwise
 * be classified on nothing at all.
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
 * Build evidence from plain text rows -- the CSV path, and any other caller
 * that already has `string[][]`.
 *
 * Rows shorter than the header row are normal (a trailing empty field is
 * often simply absent), so a missing cell reads as blank rather than
 * throwing.
 */
export function textColumnSamples(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): Record<string, ColumnCellSample[]> {
  const scanned = rows.slice(0, COLUMN_SCAN_ROWS);
  const samples: Record<string, ColumnCellSample[]> = {};

  headers.forEach((header, index) => {
    // First occurrence wins, matching mapHeadersToFields' own handling of a
    // header row that repeats the same text twice.
    if (samples[header] !== undefined) return;
    samples[header] = sampleColumnCells(
      scanned.map(row => ({ text: row[index] ?? '' }))
    );
  });

  return samples;
}

/**
 * Pool the evidence from several sources into one set.
 *
 * One mapping covers every ticked worksheet (see csv/import-plan.ts), so
 * the decision about a `Date` column has to be made on all of their values
 * at once. A tab whose Date column happens to be empty must not out-vote
 * the tab that shows what the column actually holds, and a workbook whose
 * tabs disagree should come out `mixed` -- which is the honest answer.
 *
 * The result stays capped at COLUMN_SAMPLE_SIZE per header however many
 * sheets are ticked.
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
