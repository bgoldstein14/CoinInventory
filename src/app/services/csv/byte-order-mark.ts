 /*
  * UTF-8 byte-order mark handling for CSV export and import.
  *
  * Without a BOM, Excel decodes a `.csv` with the ANSI codepage (windows-1252),
  * so UTF-8 `¢` (0xC2 0xA2) shows as `Â¢` and `½` as `Â½`. Exports therefore
  * prepend `BOM`.
  *
  * Every text import calls `stripBom` first. Otherwise a re-imported export's
  * first header would read `﻿Coin Type` and that column would silently stay
  * unmapped. Many other programs also write UTF-8-with-BOM CSVs.
  */

/** U+FEFF, written at the start of exported CSV text (encoded as `EF BB BF`). */
export const BOM = '﻿';

/**
 * Removes a leading byte-order mark. Only the first character is checked; a
 * U+FEFF elsewhere is part of the data.
 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Cleans a header cell from a file by removing invisible characters that break
 * exact comparison:
 *   U+FEFF  zero-width no-break space / BOM
 *   U+200B  zero-width space
 *   U+200C  zero-width non-joiner
 *   U+200D  zero-width joiner
 *   U+00A0  non-breaking space -> an ordinary space (it separates words, e.g. `Cert No`)
 * Surrounding whitespace is trimmed; internal spacing is kept.
 */
export function cleanHeaderText(raw: string): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[﻿​‌‍]/g, '')
    .replace(/ /g, ' ')
    .trim();
}
