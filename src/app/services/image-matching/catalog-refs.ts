 /*
 * Catalogue references and era dates for ancient and world coins, which have
 * no mint year or denomination, e.g. "Caracalla Denarius - Sear 6819 - Obverse.jpg"
 * or "67-68 CE 1st Revolt - Obverse - 2.jpg".
 *
 * - Era dates are reported for display only; they never feed the year
 *   attribute (a 67 AD coin must not match one recorded as 1967).
 * - Catalogue references are folded into one coin-type token ("Sear 6819" ->
 *   "sear6819") on both filenames and records. Unfolded, the bare number is
 *   dropped and a lone "sear" would match every Sear-catalogued coin.
 * - With coin type as the only comparable attribute, ancients score below the
 *   auto threshold and always land in review.
  */

import { CATALOG_PREFIXES } from './filename-vocabulary';

/**
 * A catalogue prefix followed by its number: "Sear 6819", "RIC 34",
 * "Hendin 736". One optional space, hyphen or period between them.
 */
const CATALOG_REFERENCE = new RegExp(
  `\\b(${CATALOG_PREFIXES.join('|')})[\\s.-]?(\\d{1,5}[a-z]?)\\b`,
  'gi'
);

/**
 * The compact Sear form: "S3794", "S11542". Safe because US mint marks follow
 * the year ("1875CC"), never precede a number.
 */
const COMPACT_SEAR = /\bs(\d{3,5})\b/gi;

/**
 * Era dates: "67-68 CE", "450-350 BC", "117 AD", "3rd century BC".
 * Captured for display only -- never compared against a mint year.
 */
const ERA_DATE = /\b(\d{1,4})\s*(?:[-–]\s*(\d{1,4}))?\s*(BCE|BC|CE|AD)\b/i;

/**
 * Catalogue references found in a filename, normalized to single tokens:
 * "Sear 6819" -> "sear6819", "RIC 34" -> "ric34", "S3794" -> "sear3794".
 * Deduplicated, in order of appearance.
 */
export function findCatalogRefs(rawText: string): string[] {
  const text = String(rawText ?? '');
  const refs: string[] = [];

  for (const match of text.matchAll(CATALOG_REFERENCE)) {
    refs.push(`${match[1].toLowerCase()}${match[2].toLowerCase()}`);
  }

  // The compact form only counts when no spelled-out reference was found, so
  // "Sear 6819" is never also reported as some unrelated "s6819".
  if (refs.length === 0) {
    for (const match of text.matchAll(COMPACT_SEAR)) {
      refs.push(`sear${match[1]}`);
    }
  }

  return [...new Set(refs)];
}

/**
 * The era date as written, e.g. "67-68 CE" or "450-350 BC", for display only.
 * Null when absent.
 */
export function findEraDate(rawText: string): string | null {
  const match = ERA_DATE.exec(String(rawText ?? ''));
  if (!match) return null;

  const span = match[2] ? `${match[1]}-${match[2]}` : match[1];
  return `${span} ${match[3].toUpperCase()}`;
}

/**
 * Join catalogue prefixes to the number that follows them, inside a token list.
 *
 * ["caracalla", "denariu", "sear", "6819"] -> ["caracalla", "denariu", "sear6819"]
 *
 * Must be applied to both filenames and coin records, or the tokens won't match.
 */
export function foldCatalogRefs(tokens: string[]): string[] {
  const prefixes = new Set(CATALOG_PREFIXES);
  const folded: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const next = tokens[i + 1];
    if (prefixes.has(tokens[i]) && next !== undefined && /^\d{1,5}[a-z]?$/.test(next)) {
      folded.push(`${tokens[i]}${next}`);
      i++; // the number has been absorbed
      continue;
    }
    folded.push(tokens[i]);
  }

  return folded;
}
