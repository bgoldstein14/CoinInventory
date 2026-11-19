 /*
 * Extracts the year and mint mark from a filename. Kept together because
 * they are often joined in one token:
 *
 *       1875-CC 20-cent Choice F - Obverse.jpg     hyphen separated
 *       1875CC - VF30 - 2 - Obverse.jpg            no separator
 *       1873 - CLOSED.jpg                          not a mint mark
  */

import { CAMERA_PREFIXES, MINT_CODES, MINT_NAMES } from './reference-tables';
import { indexOfSequence, isPlausibleYear } from './text-tokens';

/**
 * A four-digit year with a mint code glued directly to it: "1875cc", "1906s".
 * Only real mint codes are allowed, so "1875th" and "1913mm" are rejected.
 */
const YEAR_WITH_GLUED_MINT = /^(1[6-9]\d{2}|2[01]\d{2})(cc|[pdswocm])$/;

/**
 * Extract a year. Accepts the glued form "1875CC" and rejects camera sequence
 * numbers ("IMG_2024.jpg" is not a 2024 coin).
 */
export function extractYear(tokens: string[], isFileName: boolean): number | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // A plain four-digit token, or a year with a mint code glued to it.
    const glued = YEAR_WITH_GLUED_MINT.exec(token);
    const digits = /^\d{4}$/.test(token) ? token : glued?.[1];
    if (!digits) continue;

    const value = Number(digits);
    if (!isPlausibleYear(value)) continue;

    if (isFileName && i > 0 && CAMERA_PREFIXES.has(tokens[i - 1])) continue;

    return value;
  }
  return null;
}

/**
 * Extract a mint mark only from unambiguous forms; a bare "s" or "d"
 * elsewhere is not a mint mark:
 *
 *   A. attached to the year        "1881-S", "1881_S", "1916 D", "1875CC"
 *   B. delimited on both sides     "morgan-cc-obverse"
 *   C. spelled out                 "carson city", "denver"
 *   D. explicitly labelled         "mintmark s", "mm: cc"
 *
 * Two different codes found -> null (ambiguous).
 */
export function extractMintMark(separated: string, tokens: string[]): string | null {
  const found = new Set<string>();

  // A. year followed by an optional separator run and a 1-2 letter code.
  //    `[\s_-]*` permits "1875cc"; the trailing lookahead stops
  //    "1921_Peace" yielding "p" and "1873 - CLOSED" yielding "c".
  const yearAdjacent = /(?:^|[^0-9a-z])(?:1[6-9]\d{2}|2[01]\d{2})[\s_-]*(cc|[pdswocm])(?![a-z0-9])/g;
  for (const match of separated.matchAll(yearAdjacent)) {
    found.add(match[1]);
  }

  // B. code fenced by explicit "-" or "_" on BOTH sides.
  const fenced = /[-_](cc|[pdswocm])[-_]/g;
  for (const match of separated.matchAll(fenced)) {
    found.add(match[1]);
  }

  // C. spelled-out mint names.
  for (const entry of MINT_NAMES) {
    const start = indexOfSequence(tokens, entry.words);
    if (start >= 0) found.add(entry.code);
  }

  // D. explicitly labelled.
  const labelled = /(?:^|[^a-z0-9])(?:mint[\s_-]*mark|mintmark|mm)[\s_-]*(cc|[pdswocm])(?![a-z0-9])/g;
  for (const match of separated.matchAll(labelled)) {
    found.add(match[1]);
  }

  if (found.size !== 1) return null; // zero = unknown, more than one = ambiguous
  const [code] = [...found];
  return MINT_CODES.has(code) ? code : null;
}

/**
 * Glued year+mint tokens ("1875cc") in the list, so filename-parser.ts can
 * drop them from the coin-type words.
 */
export function gluedYearTokens(tokens: string[]): string[] {
  return tokens.filter(token => YEAR_WITH_GLUED_MINT.test(token));
}
