/* ===========================================================================
 * year-mint-parser.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Pulling the YEAR and the MINT MARK out of a filename. Public entry points
 *   are `extractYear` and `extractMintMark`.
 *
 * WHY IT IS ITS OWN FILE
 *   These two belong together because in real filenames they are physically
 *   joined. Every one of these is from the share:
 *
 *       1875-CC 20-cent Choice F - Obverse.jpg     hyphen separated
 *       1875CC - VF30 - 2 - Obverse.jpg            NO separator at all
 *       1906-S $5 - XF-AU.jpg                      hyphen separated
 *       1873 - CLOSED.jpg                          NOT a mint mark
 *
 *   The no-separator form is the interesting one: "1875CC" is a SINGLE token,
 *   so the year extractor cannot just look for a four-digit token, and the
 *   mint extractor has to read it out of the middle of a word. Splitting the
 *   two apart into different files would mean two places had to agree on
 *   exactly which glued-together shapes are legal.
 *
 *   It is also, along with filename-parser.ts, where the matcher is most
 *   paranoid -- almost every rule here exists to REFUSE something.
 * =========================================================================== */

import { CAMERA_PREFIXES, MINT_CODES, MINT_NAMES } from './reference-tables';
import { indexOfSequence, isPlausibleYear } from './text-tokens';

/**
 * A four-digit year with a mint code glued directly to it: "1875cc", "1906s".
 *
 * Kept deliberately tight. Only real mint codes are allowed after the digits,
 * so "1875th", "2008x" and "1913mm" are all rejected rather than silently
 * yielding a year.
 */
const YEAR_WITH_GLUED_MINT = /^(1[6-9]\d{2}|2[01]\d{2})(cc|[pdswocm])$/;

/**
 * Extract a year, but refuse camera sequence numbers.
 *
 * "IMG_2024.jpg" and "DSC_1998.jpg" are photos, not coins from 2024/1998.
 * A year-shaped number immediately preceded by a camera prefix is rejected.
 *
 * Also accepts the glued form "1875CC". `tokenize` splits only on
 * non-alphanumerics, so "1875CC" arrives as one token and would otherwise
 * fail the plain four-digit test -- which is exactly the bug that made
 * "1875CC - VF30 - 2 - Obverse.jpg" parse with no year at all.
 *
 * (The "1875S" spelling already worked by accident: `singularize` chops the
 * trailing "s" off tokens longer than three characters, turning it into a
 * plain "1875". The glued rule below covers it properly rather than relying
 * on that side effect.)
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
 * Extract a mint mark ONLY from unambiguous forms.
 *
 * Defect #6 was that any bare "s", "d" or "c" token anywhere in a filename
 * became a mint mark. Now a single letter must be positioned like a real
 * mint mark:
 *
 *   A. attached to the year        "1881-S", "1881_S", "1916 D", "1875CC"
 *   B. delimited on both sides     "morgan-cc-obverse"
 *   C. spelled out                 "carson city", "denver"
 *   D. explicitly labelled         "mintmark s", "mm: cc"
 *
 * If two different codes are found we return null -- ambiguous evidence is
 * treated as no evidence.
 *
 * Form A is what handles the real "1875-CC" / "1875CC" / "1906-S" names, and
 * it is also what REFUSES "1873 - CLOSED.jpg": the separator run is allowed to
 * be empty or any mix of spaces, hyphens and underscores, but the code that
 * follows must then END -- the trailing `(?![a-z0-9])` means the "C" of
 * "CLOSED" is rejected because a letter follows it. Without that lookahead
 * every "1873 - Closed 3" variety note would invent a Charlotte mint mark.
 */
export function extractMintMark(separated: string, tokens: string[]): string | null {
  const found = new Set<string>();

  // A. year followed by an optional separator run and a 1-2 letter code.
  //    `[\s_-]*` permits the no-separator form "1875cc"; the trailing
  //    lookahead stops "1921_Peace" from yielding "p".
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
 * The glued year+mint token for a given year, if the token list holds one.
 *
 * filename-parser.ts uses this to drop "1875cc" from the coin-type words --
 * without it the token survives (it is neither a bare number nor a single
 * letter) and becomes fake design evidence.
 */
export function gluedYearTokens(tokens: string[]): string[] {
  return tokens.filter(token => YEAR_WITH_GLUED_MINT.test(token));
}
