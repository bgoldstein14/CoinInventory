/* ===========================================================================
 * catalog-refs.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Ancient and world coins, which are catalogued completely differently from
 *   US coins. Public entry points: `findCatalogRefs`, `findEraDate`,
 *   `foldCatalogRefs`.
 *
 * ---------------------------------------------------------------------------
 * WHY ANCIENTS NEED SPECIAL HANDLING
 * ---------------------------------------------------------------------------
 *   Every rule in this matcher leans on a mint year and a denomination:
 *
 *       1881-S Morgan Dollar        year 1881, mint S, denomination Dollar
 *
 *   An ancient coin has NEITHER. These are real filenames:
 *
 *       Caracalla Denarius - Sear 6819 - Obverse.jpg
 *       Constantine - RIC 34 - Obverse.jpg
 *       Bar Kochba - Hendin 736 - Obverse 1.jpg
 *       67-68 CE 1st Revolt - Obverse - 2.jpg
 *
 *   Instead of a year they carry an ERA DATE ("67-68 CE", "450-350 BC"), and
 *   instead of a denomination they carry a CATALOGUE REFERENCE -- a citation
 *   into a standard reference work. "Sear 6819" identifies one specific coin
 *   type as precisely as "1881-S Morgan Dollar" does.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION: ANCIENTS MATCH ON COIN-TYPE TEXT ONLY, AND NEVER AUTO-ASSIGN
 * ---------------------------------------------------------------------------
 *   1. The era date is REPORTED but never scored. "67-68 CE" is not a mint
 *      year and must never be compared against one -- feeding it into the year
 *      attribute would invite a 67 AD coin to match a coin recorded as 1967.
 *      So `parsedYear` stays null for ancients, on purpose.
 *
 *   2. The catalogue reference is FOLDED INTO THE COIN-TYPE WORDS. "Sear 6819"
 *      becomes the single token "sear6819". Folding matters because the bare
 *      "6819" would be thrown away by the no-bare-digits rule, and a lone
 *      "sear" would then match every Sear-catalogued coin in the collection.
 *      Joined, it is a precise identifier -- and because `foldCatalogRefs` is
 *      applied to BOTH sides (filenames and coin records), a record whose
 *      variety reads "Sear 6819" produces the identical token and matches.
 *
 *   3. The CONSEQUENCE, which is the point: an ancient's only comparable
 *      attribute is coin type. Coin type carries weight 0.22 out of a total of
 *      ~1.08, so its coverage damping caps the score near 0.76 -- below the
 *      0.85 auto threshold -- and it is only ONE strong attribute, below the
 *      two the gate demands. Ancients therefore land in 'review' with a good
 *      ranked shortlist and are never auto-assigned. That is the intended
 *      outcome, not a limitation: with no year and no denomination there is
 *      not enough independent evidence to file a photo unattended.
 * =========================================================================== */

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
 * The compact Sear form: "S3794", "S11542".
 *
 * Judgement call, and the loosest rule in this file: a lone "S" plus 3-5
 * digits is taken to be a Sear number. It is safe here because a US mint mark
 * is never glued to a number in this collection (mint marks attach to the
 * YEAR -- "1875CC" -- and the year is four digits, which this pattern
 * excludes by requiring the token to start with the letter).
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
 *
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
 * The era date as written, e.g. "67-68 CE" or "450-350 BC". Null when absent.
 *
 * Returned for display and for the UI to show beside the coin. It is
 * deliberately NOT turned into a number: see the header for why an era date
 * must never reach the year comparison.
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
 * MUST be applied to both sides of a comparison. The filename parser calls it
 * on the words left over from a filename; coin-signature.ts calls it on a
 * record's coinType/variety text. If only one side folded, a record's
 * "Sear 6819" and a filename's "Sear 6819" would produce different tokens and
 * could never match -- the exact apples-to-oranges failure text-tokens.ts
 * exists to prevent.
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
