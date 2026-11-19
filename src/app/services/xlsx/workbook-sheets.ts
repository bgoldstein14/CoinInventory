 /*
  * Converts worksheet grids into `headers: string[]` + `rows: string[][]`, the
  * shape the CSV import (mapping screen, completeness rule, preview,
  * exceptions) already uses, so nothing downstream knows a workbook was involved.
  *
  * Spreadsheet layouts handled:
  * - Title banner: the header row is the first row with at least two filled cells.
  * - Merged header cells: a blank heading keeps its column and is named by its
  *   column letter, so later columns don't shift left.
  * - Blank separator rows: dropped.
  * - Trailing columns with neither heading nor data: dropped. Data under a blank
  *   heading is kept.
  * - Non-inventory or empty tabs: marked, never thrown.
  *
  * `importable: false` means there is nothing to import (no header row or no
  * rows). Unrecognised headings are still importable; `recognisedColumns` only
  * decides which tabs are ticked by default.
  */

import { cleanHeaderText } from '../csv/byte-order-mark';
import { mapHeadersToFields } from '../csv/header-synonyms';
import {
  COLUMN_SCAN_ROWS,
  ColumnCellSample,
  sampleColumnCells
} from '../csv/date-column-shape';
import { cellToText, WorkbookCellValue } from './workbook-cell-text';

/** One worksheet as the parser returns it. */
export interface RawWorksheet {
  /** The tab's name in Excel. */
  sheet: string;
  /** Row-major grid of parsed cell values. */
  data: WorkbookCellValue[][];
}

/** One worksheet in the shape the CSV importer consumes. */
export interface WorkbookSheet {
  /** The tab's name, shown in the picker and on exception rows. */
  name: string;
  /** The heading row, cleaned; `[]` when none was found. */
  headers: string[];
  /** Data rows, each exactly `headers.length` long. */
  rows: string[][];
  rowCount: number;
  /** False only when there is nothing on this sheet to import. */
  importable: boolean;
  /** Why not, as a user-facing sentence; empty when importable. */
  skipReason: string;
  /** Headings that auto-mapped to a coin field; drives default ticks. */
  recognisedColumns: number;
  /**
   * A few parsed cells per column (keyed by header text) for the auto-mapper
   * when a heading is ambiguous, e.g. `Date` as coin year or calendar date (see
   * csv/date-column-shape.ts). The only place a cell's Excel type survives, via
   * `typedDate`. Capped by COLUMN_SAMPLE_SIZE.
   */
  valueSamples: Record<string, ColumnCellSample[]>;
}

/** Filled cells a row needs to be taken as the heading row. */
const MIN_HEADER_CELLS = 2;

/** 0 -> A, 25 -> Z, 26 -> AA, as Excel labels columns. */
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
 * Takes per-column samples from the parsed cells, recording `typedDate` while
 * the `Date` object still exists (e.g. `1981-01-01` text could look like a coin
 * year). Bounded by COLUMN_SCAN_ROWS and COLUMN_SAMPLE_SIZE.
 */
function collectValueSamples(
  headers: readonly string[],
  bodyRows: readonly (readonly WorkbookCellValue[])[]
): Record<string, ColumnCellSample[]> {
  const scanned = bodyRows.slice(0, COLUMN_SCAN_ROWS);
  const samples: Record<string, ColumnCellSample[]> = {};

  headers.forEach((header, index) => {
    // First occurrence wins, as in mapHeadersToFields.
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
 * Converts every worksheet, in workbook order, including ones that can't be
 * imported, so the picker can show why each was passed over.
 */
export function toWorkbookSheets(rawSheets: RawWorksheet[]): WorkbookSheet[] {
  return rawSheets.map(raw => convertSheet(raw));
}

function convertSheet(raw: RawWorksheet): WorkbookSheet {
  const grid = (raw.data ?? []).map(row => (row ?? []).map(cell => cellToText(cell)));

  const anyContent = grid.some(row => row.some(cell => !isBlank(cell)));
  if (!anyContent) return emptySheet(raw.sheet, 'This sheet is empty.');

  // Heading row: the first with at least two filled cells (skips title banners).
  const headerIndex = grid.findIndex(
    row => row.filter(cell => !isBlank(cell)).length >= MIN_HEADER_CELLS
  );
  if (headerIndex === -1) {
    return emptySheet(raw.sheet, 'No column heading row could be found on this sheet.');
  }

  const headerRow = grid[headerIndex];
  const bodyRows = grid.slice(headerIndex + 1);

  // Widest of heading and data rows, so data past the headings isn't truncated.
  const rawWidth = Math.max(headerRow.length, ...bodyRows.map(row => row.length), 0);

  // Trim trailing columns with neither a heading nor any data.
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
    // Blank heading: keep the column, named by its Excel column letter.
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

  // The same body rows, still typed, with blank rows dropped as in `rows`, so
  // the indexes line up with `bodyRows`.
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
    // Judged with column values, so a `Date` column of purchase dates isn't
    // counted as recognised.
    recognisedColumns: Object.keys(mapHeadersToFields(headers, valueSamples)).length,
    valueSamples
  };
}
