/* ===========================================================================
 * text-tokens.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The low-level TOKEN PLUMBING that both parsers stand on:
 *     - turning a string into a clean list of tokens (`tokenize`,
 *       `singularize`, `meaningfulTokens`),
 *     - finding and removing runs of tokens (`indexOfSequence`, `removeRange`,
 *       `findDenomination`, `removeDenominationTokens`),
 *     - and a handful of tiny string / number helpers used for display
 *       (`baseName`, `stripExtension`, `titleCase`, `capitalize`, `round`)
 *       plus the year sanity check (`isPlausibleYear`).
 *
 * WHY IT IS ITS OWN FILE
 *   These functions know nothing about coins OR about matching -- they just
 *   chop text up. Both the filename parser and the coin-record parser need
 *   exactly the same chopping, and if the two ever drifted apart the matcher
 *   would start comparing apples to oranges (a filename token that was
 *   singularized against a record token that was not, for example). Having
 *   one shared home guarantees both sides speak the identical token language.
 *
 *   Every function here is pure: same input, same output, no state.
 * =========================================================================== */

import { MIN_COIN_YEAR } from './matching-thresholds';
import {
  CERT_COMPANIES,
  DENOMINATION_RULES,
  GRADE_PATTERN,
  STOP_WORDS
} from './reference-tables';

/* ---------------------------------------------------------------------------
 * PARSING HELPERS
 * ------------------------------------------------------------------------- */

/**
 * Split text into normalized tokens.
 *
 * Everything downstream compares WHOLE tokens, which is the fix for
 * defect #3: "2599001" is one token and can never equal "25".
 */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(token => singularize(token));
}

/**
 * Very light plural stripping so "dollars" == "dollar" and "cents" == "cent".
 * Only applied to words longer than 3 characters that do not end in "ss",
 * so mint marks ("s") and shorthand ("ms") survive untouched.
 *
 * ACRONYM EXCEPTION: the grading services are not plurals. Without this guard
 * "pcgs" became "pcg", "anacs" became "anac" and "segs" became "seg" -- none
 * of which are in CERT_COMPANIES, so the company went unrecognised AND the
 * mangled leftover survived as fake "coin type" evidence, making any two
 * PCGS-graded coins look slightly alike. Real filenames hit this constantly:
 * "1870 $1 - PCGS PF62CAM- Obverse.jpg".
 */
export function singularize(token: string): string {
  if (CERT_COMPANIES.has(token)) return token;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Drop stop words; what remains describes the coin itself. */
export function meaningfulTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (STOP_WORDS.has(token)) continue;
    if (token.length <= 1) continue;
    if (/^\d+$/.test(token)) continue;
    if (GRADE_PATTERN.test(token)) continue;
    if (CERT_COMPANIES.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/**
 * Find a denomination by scanning the token list for the first (most
 * specific) rule whose pattern appears as consecutive tokens.
 *
 * Returns where it matched so the caller can remove those tokens from the
 * coin-type words.
 */
export function findDenomination(
  tokens: string[],
  options: FindDenominationOptions = {}
): { key: string; label: string; start: number; length: number } | null {
  for (const rule of DENOMINATION_RULES) {
    for (const pattern of rule.patterns) {
      let from = 0;
      for (;;) {
        const start = indexOfSequenceFrom(tokens, pattern, from);
        if (start < 0) break;
        if (!options.allowCountedCent && isCountedCentTrap(tokens, pattern, start)) {
          // Not this occurrence -- keep looking further along the name.
          from = start + 1;
          continue;
        }
        return { key: rule.key, label: rule.label, start, length: pattern.length };
      }
    }
  }
  return null;
}

/** Options for {@link findDenomination}. */
export interface FindDenominationOptions {
  /**
   * Let a bare "cent" preceded by a count still answer ONE CENT.
   *
   * Exactly one caller sets this, and not to get an answer. filename-parser.ts
   * has to tell the face-value reader whether THE WORDS ALREADY NAMED A COIN,
   * because that is how "$50" in "1881-S Morgan Dollar $50.jpg" is recognised
   * as a price rather than a second face value. For that question "50 cent" in
   * "1913 50-Cent Canadian $20" counts as the words naming a coin, even though
   * the key it produces ('cent') is the wrong one to publish. So the parser
   * asks twice: once normally for the ANSWER, and once with this flag for the
   * CONTEXT. See the guard below for what is being suppressed and why.
   */
  allowCountedCent?: boolean;
}

/**
 * "3 CENT" IS NOT A ONE-CENT COIN -- the trap this guard closes.
 *
 * The bare word "cent" is listed (correctly) as a spelling of the ONE CENT
 * piece, and it is matched anywhere in the token list. That is fine for
 * "Indian Head Cent" and fatal for a face value written with a space:
 *
 *     1864 2 cent - Obverse.jpg          -> ['1864','2','cent']
 *     1866 3 cent silver - Obverse.jpg   -> ['1866','3','cent','silver']
 *     1875 20 cent - Obverse.jpg         -> ['1875','20','cent']
 *
 * Every one of those was being read as a ONE CENT piece. That is not merely
 * a weak guess, it is an actively harmful one: a wrong denomination is a HARD
 * VETO, so the photo was disqualified from its own coin record and vanished
 * from the import with a skip reason blaming the coin. The owner saw exactly
 * this -- photographs of a coin that "aren't coming up as a match or a near
 * match at all".
 *
 * Why the fix is to read NOTHING rather than to read "two cent".
 *   Reading "2 cent" as the Two Cent piece would be the generous choice, and
 *   it is probably what the name means. But denomination-units.ts refuses the
 *   spaced form on purpose -- the hyphen in "20-cent" is its whole defence
 *   against "Stamp - 11 - 3 cent.jpg" -- and widening that here, in the
 *   shared table used by coin RECORDS as well as filenames, would undo a
 *   deliberate guard on an inference. So this guard only DELETES a wrong
 *   answer. The attribute ends up absent, the scorer leaves it out of both
 *   numerator and denominator, and nothing is vetoed on a misreading.
 *
 * A preceding four-digit YEAR is not a count. "1870 Cent - Obverse.jpg" is a
 * one-cent coin struck in 1870 and must go on reading as one, which is why
 * `isPlausibleYear` is consulted rather than "is it a number".
 */
function isCountedCentTrap(tokens: string[], pattern: string[], start: number): boolean {
  // Only the bare one-word spelling is at risk; ['one','cent'] and ['1c']
  // say which coin they mean.
  if (pattern.length !== 1 || pattern[0] !== 'cent') return false;
  const preceding = tokens[start - 1];
  if (!preceding || !/^\d+$/.test(preceding)) return false;
  const value = Number(preceding);
  return value !== 1 && !isPlausibleYear(value);
}

/** `indexOfSequence`, but starting the search at `from`. */
export function indexOfSequenceFrom(tokens: string[], pattern: string[], from: number): number {
  if (pattern.length === 0 || from < 0) return -1;
  const tail = indexOfSequence(tokens.slice(from), pattern);
  return tail < 0 ? -1 : tail + from;
}

/** Index of `pattern` as a run of consecutive entries in `tokens`, or -1. */
export function indexOfSequence(tokens: string[], pattern: string[]): number {
  if (pattern.length === 0 || pattern.length > tokens.length) return -1;
  outer: for (let i = 0; i <= tokens.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (tokens[i + j] !== pattern[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function removeRange(tokens: string[], start: number, length: number): string[] {
  return [...tokens.slice(0, start), ...tokens.slice(start + length)];
}

/** Remove words from a coin's type text that merely restate its denomination. */
export function removeDenominationTokens(tokens: string[], key: string): string[] {
  const rule = DENOMINATION_RULES.find(r => r.key === key);
  if (!rule) return tokens;
  for (const pattern of rule.patterns) {
    const start = indexOfSequence(tokens, pattern);
    if (start >= 0) return removeRange(tokens, start, pattern.length);
  }
  return tokens;
}

/** 1600 .. next year. Anything outside is not a mint year. */
export function isPlausibleYear(value: number): boolean {
  const maxYear = new Date().getFullYear() + 1;
  return Number.isInteger(value) && value >= MIN_COIN_YEAR && value <= maxYear;
}

/* ---------------------------------------------------------------------------
 * SMALL UTILITIES
 * ------------------------------------------------------------------------- */

export function baseName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || String(path ?? '');
}

export function stripExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
}

export function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, c => c.toUpperCase());
}

export function capitalize(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

/** Two decimal places, so scores compare and display consistently. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
