 /*
 * workbook-sheets.ts — a worksheet grid becomes headers + rows.
 * ---- WHY THIS FILE EXISTS ----
 * The CSV import already has everything the Excel import needs: a mapping
 * screen, the 2-of-3 completeness rule, a preview, an exceptions list. All of
 * it is built on two arrays -- `headers: string[]` and `rows: string[][]`.
 *
 * So the entire job of the `.xlsx` path is to produce those two arrays, and
 * this is the file that does it. Nothing downstream learns that a workbook
 * was involved. One import path, one mapping UI, one validation path; the
 * alternative was a second import modal that would have drifted away from
 * the first within a release or two.
 *
 * ---- WHAT A REAL SPREADSHEET DOES THAT A CSV CANNOT ----
 * A CSV is a rectangle of text by definition. A worksheet is a canvas, and
 * people use it as one. The cases handled below are all taken from what
 * collectors' workbooks actually look like:
 *
 *   A MERGED TITLE BANNER across the top. Row 1 is "My Coin Collection"
 *   followed by blanks, row 2 is empty, row 3 is the real heading row.
 *   Taking row 1 as the headers gives a one-column sheet called "My Coin
 *   Collection", nothing maps, and the user concludes the importer is
 *   broken. The rule used here is THE FIRST ROW WITH AT LEAST TWO FILLED
 *   CELLS, because a merged banner has exactly one and a heading row
 *   essentially always has more.
 *
 *   MERGED HEADER CELLS, which leave their neighbours empty. The temptation
 *   is to drop the empty column; that is the worst available option, because
 *   every cell to its right shifts one place left and the result still looks
 *   plausible -- grades land in the variety column and nobody notices. The
 *   column is KEPT and given a name from its spreadsheet column letter, so
 *   the alignment holds and the user has something to point at.
 *
 *   BLANK ROWS between groups of coins. Dropped -- they are decoration.
 *
 *   TRAILING COLUMNS that were formatted once and never filled. Excel
 *   cheerfully reports the sheet as that wide. Dropped only when they have
 *   neither a heading NOR any data; a column with data under a blank heading
 *   is still the user's data and is kept.
 *
 *   NON-INVENTORY TABS -- "Price Guide", "Totals", "Notes", or the empty
 *   Sheet2 and Sheet3 nobody deleted. These are marked, not thrown. A
 *   workbook must never fail as a whole because one tab is a scratchpad.
 *
 * ---- WHY `importable` IS NOT A GUESS ABOUT CONTENT ----
 * `importable: false` means there is literally nothing to import -- no
 * heading row, or no rows beneath one. It does NOT mean "this does not look
 * like coins to me". A sheet whose headings are all unrecognised is still
 * importable, because the user can map them by hand, and refusing it would
 * be the importer overruling the person who owns the data.
 *
 * `recognisedColumns` carries the softer signal instead: it is what the
 * sheet picker uses to decide which tabs to TICK by default. A tab that
 * recognises nothing is listed, untickled, with the reason shown -- visible
 * and one click from being included.
  */

import { cleanHeaderText } from '../csv/byte-order-mark';
import { mapHeadersToFields } from '../csv/header-synonyms';
import {
  COLUMN_SCAN_ROWS,
  ColumnCellSample,
  sampleColumnCells
} from '../csv/date-column-shape';
import { cellToText, WorkbookCellValue } from './workbook-cell-text';

/** One worksheet exactly as the parser hands it over. */
export interface RawWorksheet {
  /** The tab's name in Excel. */
  sheet: string;
  /** Row-major grid of parsed cell values. */
  data: WorkbookCellValue[][];
}

/** One worksheet in the shape the CSV importer already consumes. */
export interface WorkbookSheet {
  /** The tab's name in Excel, shown in the picker and on exception rows. */
  name: string;
  /** The heading row, cleaned; `[]` when none was found. */
  headers: string[];
  /** Data rows, each exactly `headers.length` long. */
  rows: string[][];
  /** `rows.length`, named so the picker reads clearly. */
  rowCount: number;
  /** False only when there is nothing on this sheet that could be imported. */
  importable: boolean;
  /** Why not, in a sentence fit to show the user. Empty when importable. */
  skipReason: string;
  /** How many headings auto-mapped onto a coin field. Drives default ticks. */
  recognisedColumns: number;
  /**
   * A handful of this sheet's cells per column, keyed by header text, for
   * the auto-mapper to read when a heading alone is ambiguous (today: a
   * column headed `Date`, which may be a coin year or a calendar date --
   * see csv/date-column-shape.ts).
   *
   * THIS IS THE ONLY PLACE THE CELL'S EXCEL TYPE SURVIVES. Everything else
   * on this interface is flattened text, deliberately: nothing below the
   * mapping grid is allowed to know a workbook was involved. But flattening
   * a `Date` to `2024-03-15` throws away the one fact that settles the
   * ambiguity for free, so the samples are taken from the PARSED cells and
   * carry `typedDate`. They are capped and tiny -- see COLUMN_SAMPLE_SIZE
   * -- so holding them on every sheet of a workbook costs nothing.
   */
  valueSamples: Record<string, ColumnCellSample[]>;
}

/** How many filled cells a row needs before it is believed to be the headings. */
const MIN_HEADER_CELLS = 2;

/** 0 -> A, 25 -> Z, 26 -> AA. Matches the column letters Excel shows. */
function columnLetter(index: number): string {
  let letters = '';
  let remaining = index;
  while (remaining >= 0) {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return letters;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Take the auto-mapper's per-column samples from the PARSED cells rather
 * than from the flattened text.
 *
 * The distinction is the whole value of this function. `cellToText` renders
 * a date cell as `2024-03-15`, which a pattern can usually recognise -- but
 * `1981-01-01` is a real purchase date whose rendering is indistinguishable
 * from a plausible coin year written the ISO way, and a cell's number
 * format is a fact we already have rather than something to infer. So the
 * `Date` object is spotted here, while it still exists, and recorded as
 * `typedDate` for csv/date-column-shape.ts to act on.
 *
 * Only `COLUMN_SCAN_ROWS` rows are looked at, and only up to
 * `COLUMN_SAMPLE_SIZE` non-blank values per column are kept, so this is
 * bounded work on a workbook of any size -- it runs while the user is
 * waiting for the mapping grid.
 */
function collectValueSamples(
  headers: readonly string[],
  bodyRows: readonly (readonly WorkbookCellValue[])[]
): Record<string, ColumnCellSample[]> {
  const scanned = bodyRows.slice(0, COLUMN_SCAN_ROWS);
  const samples: Record<string, ColumnCellSample[]> = {};

  headers.forEach((header, index) => {
    // First occurrence wins, matching how mapHeadersToFields treats a
    // heading row that repeats the same text.
    if (samples[header] !== undefined) return;
    samples[header] = sampleColumnCells(scanned.map(row => {
      const cell = row?.[index];
      return { text: cellToText(cell), typedDate: cell instanceof Date };
    }));
  });

  return samples;
}

function emptySheet(name: string, skipReason: string): WorkbookSheet {
  return {
    name,
    headers: [],
    rows: [],
    rowCount: 0,
    importable: false,
    skipReason,
    recognisedColumns: 0,
    valueSamples: {}
  };
}

/**
 * Convert every worksheet in a parsed workbook.
 *
 * Returns one entry per sheet IN WORKBOOK ORDER, including the ones that
 * cannot be imported -- the picker needs to show them so the user can see
 * the importer looked at them and why it passed over each one. A tab that
 * simply vanished from the list would look like a bug.
 */
export function toWorkbookSheets(rawSheets: RawWorksheet[]): WorkbookSheet[] {
  return rawSheets.map(raw => convertSheet(raw));
}

function convertSheet(raw: RawWorksheet): WorkbookSheet {
  const grid = (raw.data ?? []).map(row => (row ?? []).map(cell => cellToText(cell)));

  const anyContent = grid.some(row => row.some(cell => !isBlank(cell)));
  if (!anyContent) return emptySheet(raw.sheet, 'This sheet is empty.');

  // The heading row: the first one carrying at least two filled cells. See
  // the merged-banner note in the file header for why one is not enough.
  const headerIndex = grid.findIndex(
    row => row.filter(cell => !isBlank(cell)).length >= MIN_HEADER_CELLS
  );
  if (headerIndex === -1) {
    return emptySheet(raw.sheet, 'No column heading row could be found on this sheet.');
  }

  const headerRow = grid[headerIndex];
  const bodyRows = grid.slice(headerIndex + 1);

  // Width is the widest of the heading row and any data row, so a data
  // column that runs past the headings is not silently truncated.
  const rawWidth = Math.max(headerRow.length, ...bodyRows.map(row => row.length), 0);

  // Trim trailing columns that have neither a heading nor any data. A column
  // with data but no heading survives -- it is still the user's data, and it
  // gets a name below.
  let width = rawWidth;
  while (width > 0) {
    const index = width - 1;
    const headed = !isBlank(headerRow[index] ?? '');
    const populated = bodyRows.some(row => !isBlank(row[index] ?? ''));
    if (headed || populated) break;
    width -= 1;
  }

  const headers = Array.from({ length: width }, (_unused, index) => {
    const cleaned = cleanHeaderText(headerRow[index] ?? '');
    // A blank heading keeps its column rather than collapsing it, so nothing
    // shifts left. The name is the Excel column letter, which is what the
    // user will see when they go and look.
    return cleaned || `(column ${columnLetter(index)})`;
  });

  const rows = bodyRows
    .map(row => Array.from({ length: width }, (_unused, index) => row[index] ?? ''))
    .filter(row => row.some(cell => !isBlank(cell)));

  if (rows.length === 0) {
    return {
      ...emptySheet(raw.sheet, 'This sheet has column headings but no rows under them.'),
      headers
    };
  }

  // The same body rows, still typed, and with the blank spacer rows dropped
  // on the same test `rows` uses -- so the samples below are taken from the
  // rows that will actually be imported, and a run of blank rows at the top
  // of the sheet does not eat the scan budget. `bodyRows` is `grid` sliced
  // the same way, so the indexes line up cell for cell.
  const typedBodyRows = (raw.data ?? [])
    .slice(headerIndex + 1)
    .filter((_row, index) => (bodyRows[index] ?? []).some(cell => !isBlank(cell)));

  const valueSamples = collectValueSamples(headers, typedBodyRows);

  return {
    name: raw.sheet,
    headers,
    rows,
    rowCount: rows.length,
    importable: true,
    skipReason: '',
    // Judged WITH the column values, so a `Date` column of purchase dates
    // is not counted as a recognised coin column -- a column the mapper has
    // decided not to map is not one it recognised, and this number is what
    // ticks a worksheet by default.
    recognisedColumns: Object.keys(mapHeadersToFields(headers, valueSamples)).length,
    valueSamples
  };
}
