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
 * defect #3: "2510345" is one token and can never equal "25".
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
 */
export function singularize(token: string): string {
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
  tokens: string[]
): { key: string; label: string; start: number; length: number } | null {
  for (const rule of DENOMINATION_RULES) {
    for (const pattern of rule.patterns) {
      const start = indexOfSequence(tokens, pattern);
      if (start >= 0) {
        return { key: rule.key, label: rule.label, start, length: pattern.length };
      }
    }
  }
  return null;
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
