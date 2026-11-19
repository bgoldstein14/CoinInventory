 /*
  * Converts a parsed worksheet cell to the text the importer sees
  * (`CsvService.mapRowToCoin` takes strings). Stored values and displayed text
  * often differ:
  *
  *     stored          Excel shows
  *     45678           1/21/2025     (serial date)
  *     1250            $1,250.00     (currency format)
  *     =D2*2 / 2500    2500          (formula and cached result)
  *     true            TRUE
  *
  * - Dates come from the parser as UTC midnight, so they are formatted with UTC
  *   getters; local getters would shift every date back a day west of Greenwich.
  * - Dates are rendered as the day only; every date field is a calendar date.
  * - Numbers are written bare; csv/numeric-cell.ts handles money and weight parsing.
  */

/**
 * Value types `read-excel-file` returns for a cell. Declared here so this module
 * doesn't import the lazily loaded parser.
 */
export type WorkbookCellValue = string | number | boolean | Date | null | undefined;

/** Renders a number without separators, currency symbol or exponent notation. */
function numberToText(value: number): string {
  // NaN (a cell Excel couldn't evaluate) becomes blank rather than "NaN".
  if (!Number.isFinite(value)) return '';

  const plain = String(value);
  if (!plain.includes('e') && !plain.includes('E')) return plain;

  // Only very large or very small magnitudes reach here; trailing zeros are removed.
  const expanded = Math.abs(value) >= 1
    ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
    : value.toFixed(20);
  return expanded.includes('.') ? expanded.replace(/\.?0+$/, '') : expanded;
}

/** Renders a date as `yyyy-MM-dd` on the UTC calendar. */
function dateToText(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) return '';

  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Converts one parsed cell to importer text. Empty values return `''`, the
 * same as a blank CSV field.
 */
export function cellToText(value: WorkbookCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return numberToText(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return dateToText(value);

  // Fallback for unexpected types: stringify rather than crash mid-import.
  return String(value).trim();
}
