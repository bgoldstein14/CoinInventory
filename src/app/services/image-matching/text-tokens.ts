 /*
 * Pure token helpers shared by the filename parser and the coin-record parser,
 * so both sides tokenize identically: tokenizing, finding/removing token
 * runs, denomination lookup, and small string/number utilities.
  */

import { MIN_COIN_YEAR } from './matching-thresholds';
import {
  CERT_COMPANIES,
  DENOMINATION_RULES,
  GRADE_PATTERN,
  STOP_WORDS
} from './reference-tables';

/**
 * Split text into normalized tokens. Downstream code compares whole tokens,
 * so a cert number "2599001" never equals "25".
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
 * so mint marks ("s") and shorthand ("ms") survive untouched. Grading-service
 * acronyms ("pcgs", "anacs") are left alone.
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
   * Let a bare "cent" preceded by a count still answer ONE CENT. Used only by
   * filename-parser.ts for a context read (did the words name a coin at all?),
   * never for the published denomination.
   */
  allowCountedCent?: boolean;
}

/**
 * True when a bare "cent" follows a count ("1875 20 cent" -> ['20','cent']),
 * which must not read as a One Cent piece: a wrong denomination is a hard
 * veto. The match is dropped rather than reinterpreted; spaced face values
 * are read by denomination-units.ts. A preceding year is not a count
 * ("1870 Cent" is still a one-cent coin).
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
