 /*
 * workbook-cell-text.ts — what the user sees, as a string.
 * ---- WHY THIS FILE EXISTS ----
 * The `.xlsx` importer feeds `CsvService.mapRowToCoin`, which takes
 * `string[]`. A worksheet cell is not a string: it is a typed value plus a
 * display format, and the two frequently look nothing like each other.
 *
 *     what is stored        what Excel shows
 *     --------------        ----------------
 *     45678                 1/21/2025          (a serial date)
 *     1250                  $1,250.00          (a currency format)
 *     =D2*2 / 2500          2500               (a formula and its cache)
 *     true                  TRUE
 *
 * Every row in that table is a way to lose data quietly. The serial date is
 * the worst of them: a purchase date imported as the string "45678" is not
 * obviously a date, is not obviously wrong when skimming a grid, and cannot
 * be recovered once the original spreadsheet has moved on. The whole reason
 * the importer uses a parser that understands number formats, rather than
 * unzipping the XML and reading `<v/>`, is to know that cell is a date.
 *
 * ---- THE TIME-ZONE TRAP, WHICH IS EASY TO WRITE AND HARD TO SEE ----
 * `read-excel-file` builds its `Date` from the serial number at UTC
 * midnight. Formatting it with `getFullYear()` / `getMonth()` / `getDate()`
 * -- the obvious thing to reach for -- applies the machine's LOCAL offset.
 * Anywhere west of Greenwich that turns UTC midnight on the 21st into 5pm on
 * the 20th, so every date in the file slides back a day. It would pass
 * review in London and corrupt the collection in Denver, which is where this
 * app actually runs. The UTC getters below are not a style choice.
 *
 * ---- WHAT IS DELIBERATELY NOT DONE ----
 * No currency re-formatting. The value is written out as a bare number and
 * `csv/numeric-cell.ts` is left to do what it already does well -- it is the
 * single place in the app that decides how a money or weight cell becomes a
 * number, and it is shared with the CSV path. Writing "$1,250.00" here just
 * to have it stripped again downstream would be two conversions where one
 * will do, and the second one is lossy in a way the first is not.
 *
 * No time of day. Every date field in this app is a calendar date -- a
 * purchase, a sale -- so a cell that carries a time is rendered as its day.
  */

/**
 * The value types `read-excel-file` can hand back for one cell.
 *
 * Declared here rather than imported from the library so that this module,
 * and every test of it, stays free of the parser. The parser is loaded
 * lazily (see read-workbook.ts) and pulling its types in eagerly would
 * undermine that.
 */
export type WorkbookCellValue = string | number | boolean | Date | null | undefined;

/** Render a number without separators, without a currency symbol, and
 *  without slipping into exponent notation. */
function numberToText(value: number): string {
  // NaN reaches here from a cell Excel itself could not evaluate. "NaN" in a
  // Grade column is worse than a blank, which at least reads as "not stated".
  if (!Number.isFinite(value)) return '';

  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;

  // Only very large or very small magnitudes get here. `toFixed` caps at 100
  // decimal places and `toPrecision` is the readable way out for the large
  // side; either way the trailing zeros come off.
  const expanded = Math.abs(value) >= 1
    ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
    : value.toFixed(20);
  return expanded.includes('.') ? expanded.replace(/\.?0+$/, '') : expanded;
}

/** Render a date as `yyyy-MM-dd` on the UTC calendar. See the header. */
function dateToText(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) return '';

  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert one parsed worksheet cell into the text the importer should see.
 *
 * Returns `''` for anything with no value, which is the same thing a blank
 * CSV field produces, so `mapRowToCoin` cannot tell the two sources apart --
 * exactly the point of the whole conversion.
 */
export function cellToText(value: WorkbookCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return numberToText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return dateToText(value);

  // Nothing else is documented to come out of the parser, but a cell is
  // user-supplied data arriving through a third-party library, so the
  // fallback is a stringify rather than a crash mid-import.
  return String(value).trim();
}
