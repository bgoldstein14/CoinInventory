 /*
 * byte-order-mark.ts — the three bytes that decide whether `¢` survives.
 * ---- WHY A CSV NEEDS A BOM ----
 * Without one, a report or export containing `¢` in a denomination comes out
 * as `Â¢` — and nothing is wrong with the data. The exports write their text
 * into `new Blob([content], { type: 'text/csv' })`, and a `.csv` with no BOM
 * is decoded by Excel using the machine's ANSI codepage -- windows-1252 on a
 * US desktop -- not UTF-8. `¢` is UTF-8 `0xC2 0xA2`, and windows-1252 reads
 * those two bytes as two separate characters, `Â` and `¢`. `½` (`0xC2 0xBD`)
 * becomes `Â½` the same way. Both are everywhere in a US coin inventory:
 * "½ Cent", "1¢", "25¢".
 *
 * A UTF-8 BOM (`U+FEFF`, written as `EF BB BF`) is the signal Excel looks for
 * specifically. With it, the same file opens correctly by double-click, which
 * is how a non-technical user opens a CSV.
 *
 * ---- AND THE TRAP THAT COMES WITH THE FIX ----
 * Adding a BOM to the export is half a change. The importer did not strip
 * one, and the app advertises its own export as a re-importable template. So
 * the first header of a re-imported file would read `﻿Coin Type`, which
 * is not `Coin Type`, so the first column would arrive UNMAPPED -- silently,
 * on a mapping screen full of correctly-mapped columns, where a single blank
 * dropdown is exactly the kind of thing a user scrolls past.
 *
 * Shipping only the export half would therefore have traded a visible
 * mojibake bug for an invisible data-loss one. Both halves live here so that
 * they cannot be separated: `BOM` is what the export prepends and `stripBom`
 * is what every text import calls first.
 *
 * A BOM is not unique to our own files, either. Plenty of other programs
 * write UTF-8-with-BOM CSVs, so stripping is worth doing regardless of where
 * the file came from.
  */

/**
 * U+FEFF, the Unicode byte-order mark. Written at the front of exported CSV
 * text; `TextEncoder`/`Blob` encode it as the three bytes `EF BB BF`.
 */
export const BOM = '﻿';

/**
 * Remove a leading byte-order mark, if there is one.
 *
 * Only the FIRST character is considered. A U+FEFF anywhere else in the file
 * is a zero-width no-break space inside somebody's data, and silently
 * deleting characters out of the middle of a cell is not this function's
 * business.
 */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Clean a header cell that arrived from a file.
 *
 * Beyond the BOM this removes the other invisible characters that ride along
 * in spreadsheet headers and break an exact comparison while looking like
 * nothing at all on screen:
 *
 *   U+FEFF  zero-width no-break space / BOM
 *   U+200B  zero-width space
 *   U+200C  zero-width non-joiner
 *   U+200D  zero-width joiner
 *   U+00A0  non-breaking space -> turned into an ordinary space, not deleted,
 *           because it is a real word separator in `Cert No` typed on a Mac
 *
 * Surrounding whitespace is trimmed. Internal spacing is left alone: the
 * header text is the dictionary key the mapping and the preview table are
 * both drawn from, so it has to stay recognisably what the user wrote.
 */
export function cleanHeaderText(raw: string): string {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[﻿​‌‍]/g, '')
    .replace(/ /g, ' ')
    .trim();
}
