 /*
 * Reads a denomination from a number bound to a unit in the raw filename:
 * "$20", "50¢", "20-cent", "1-Cent". Entry point: `findUnitBoundDenomination`.
 *
 * A bare number means nothing (it could be a lot number, a price, or part of a
 * cert number), so reference-tables.ts never matches bare digits. A number
 * attached to a unit is a face value.
 *
 * This runs on the raw filename because `tokenize` strips "$", "¢" and the
 * hyphen, and the hyphen is what separates "1875-CC 20-cent" (a coin) from
 * "Stamp - 11 - 3 cent" (a stamp).
  */

import { denominationsAgree } from './reference-tables';
import { tokenize } from './text-tokens';

/** A denomination read from a unit-bound number. */
export interface UnitBoundDenomination {
  /** Canonical key, identical to the keys in DENOMINATION_RULES. */
  key: string;
  /** Friendly label for the UI. */
  label: string;
  /**
   * Tokens this match used up, so the caller can keep them out of the
   * coin-type words. ("20-cent" consumes both "20" and "cent".)
   */
  consumedTokens: string[];
}

 /*
 * US dollar face values. The set is closed: a "$N" in a filename is a face
 * value only if the amount, exactly as written, is a key here. Anything else
 * is a price.
 *
 *     "$2.50"   -> Quarter Eagle
 *     "$20"     -> Double Eagle
 *     "$20.00"  -> price (writing out the cents is how money is written)
 *     "$15"     -> price (no such coin)
 *     "$1,250"  -> no match (DOLLAR_SIGN rejects thousands separators)
 *
 * A listed amount is also treated as a price when the filename's words name a
 * different denomination (`denominationsAgree`), since a coin has one face value:
 *
 *     "1881-S Morgan Dollar $50.jpg"  -> price
 *     "2015 $25 Gold Eagle.jpg"       -> $25 (compatible with "Eagle")
 *
 * Known gap: a round price with no denomination words ("Morgan $50") is still
 * read as a face value.
 *
 * `readTrustedDenominationText` uses the same table for record fields.
  */
const DOLLAR_FACE_VALUES: Readonly<Record<string, { key: string; label: string }>> = {
  '1': { key: 'dollar', label: 'Dollar ($1)' },
  '2.50': { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)' },
  '3': { key: 'three dollar', label: 'Three Dollar ($3)' },
  '5': { key: 'half eagle', label: 'Half Eagle ($5)' },
  '10': { key: 'eagle', label: 'Eagle ($10)' },
  '20': { key: 'double eagle', label: 'Double Eagle ($20)' },

  // $25 and $50 exist only on modern bullion (e.g. American Gold Eagle, 1986-).
  '25': { key: 'twenty five dollar', label: 'Twenty-Five Dollar ($25)' },
  '50': { key: 'fifty dollar', label: 'Fifty Dollar ($50)' }
};

/** Face value in cents -> denomination, for "50c" and "50-Cent" forms. */
const CENT_FACE_VALUES: Readonly<Record<string, { key: string; label: string }>> = {
  '1': { key: 'cent', label: 'Cent (1c)' },
  '2': { key: 'two cent', label: 'Two Cent' },
  '3': { key: 'three cent', label: 'Three Cent' },
  // 5c could be a Half Dime or a Nickel, so it maps to the generic 'five cent',
  // which reference-tables.ts treats as equivalent to either.
  '5': { key: 'five cent', label: 'Five Cent (5c)' },
  '10': { key: 'dime', label: 'Dime (10c)' },
  '20': { key: 'twenty cent', label: 'Twenty Cent' },
  '25': { key: 'quarter', label: 'Quarter (25c)' },
  '50': { key: 'half dollar', label: 'Half Dollar (50c)' },
  '100': { key: 'dollar', label: 'Dollar ($1)' }
};

/**
 * "$20", "$ 5", "$2.50", "$25.00" -- any dollar amount, captured as written.
 * `matchDollarSign` decides whether it is a face value via DOLLAR_FACE_VALUES.
 * `(?![\d,])` stops "$1,200" from matching its leading "$1".
 */
const DOLLAR_SIGN = /\$\s*(\d{1,2}(?:\.\d{2})?)(?![\d,])/g;

/** "50<cent sign>", "20<cent sign>", including the full-width variant. */
const CENT_SIGN = /(\d{1,3})\s*[¢￠]/g;

/**
 * "20-cent", "1-Cent", "50-Cent". No whitespace allowed around the hyphen,
 * which keeps out "Stamp - 11 - 3 cent.jpg".
 */
const HYPHENATED_CENT = /(?:^|[^0-9a-z])(\d{1,3})-cents?(?![a-z])/gi;

 /*
 * "2 cent", "3 cent", "20 cent" -- the spaced face value.
 *
 * Without the hyphen, "Stamp - 11 - 3 cent.jpg" would match, so this form is
 * only used when the caller passes `allowSpacedCent: true`, which
 * filename-parser.ts sets from `detectNonCoin(...)`. The non-coin detector
 * rejects "stamp", "paper", "fractional" etc.:
 *
 *     Stamp - 11 - 3 cent.jpg          -> non-coin -> refused
 *     1866 2 cent - PCGS PF64RB.jpg    -> coin     -> accepted
 *
 * A four-digit year can't match ("1870 Cent" stays a 1870 one-cent coin), and
 * the word table still wins when more specific ("3 cent silver").
  */
const SPACED_CENT = /(?:^|[^0-9a-z])(\d{1,3})\s+cents?(?![a-z])/gi;

/**
 * "1/2 10<cent sign>" -- the half dime. Must be tried before CENT_SIGN, which
 * would read the "10<cent sign>" as a Dime. Accepts "½" or "1/2".
 */
const HALF_DIME_SIGN = /(?:½|1\/2)\s*10\s*[¢￠]/;

/**
 * "G$1" -- a gold dollar (the abbreviation; tokenizing would leave ['g','1']).
 * Tried before DOLLAR_SIGN so the "G" isn't lost. The lookahead rejects
 * "G$1,200" (a price).
 */
const GOLD_DOLLAR_SIGN = /(?:^|[^a-z0-9])g\s*\$\s*1(?![\d.,])/i;

/**
 * Look for a unit-bound denomination in the raw (extension-stripped) filename.
 *
 * Returns the first form found, in this order (longer spellings before the
 * shorter ones they contain):
 *   1. "G$1"           -- before the dollar sign, which would read "$1"
 *   2. dollar sign
 *   3. "1/2 10<cent>"  -- before the cent sign, which would read a Dime
 *   4. cent sign
 *   5. hyphenated cent
 *   6. spaced cent     -- only with `allowSpacedCent`
 *
 * Returns null when none is present; the caller then uses the word table.
 *
 * @param wordDenominationKey what the word table makes of the same filename,
 *        or null. Used only to reject a dollar amount that contradicts the
 *        words (a coin has one face value, so the other amount is the price).
 * @param options.allowSpacedCent set only once the filename is known to be a
 *        single coin (filename-parser.ts sets it from `detectNonCoin`).
 */
export function findUnitBoundDenomination(
  rawText: string,
  wordDenominationKey: string | null = null,
  options: { allowSpacedCent?: boolean } = {}
): UnitBoundDenomination | null {
  if (GOLD_DOLLAR_SIGN.test(rawText)) {
    return { key: 'gold dollar', label: 'Gold Dollar (G$1)', consumedTokens: ['g', '1'] };
  }

  const dollars = matchDollarSign(rawText, wordDenominationKey);
  if (dollars) return dollars;

  if (HALF_DIME_SIGN.test(rawText)) {
    return { key: 'half dime', label: 'Half Dime', consumedTokens: ['10'] };
  }

  const bound = matchCentSign(rawText) ?? matchHyphenatedCent(rawText);
  if (bound) return bound;

  // Only on a filename the caller has cleared as a coin (not a stamp or note).
  return options.allowSpacedCent ? matchSpacedCent(rawText) : null;
}

/**
 * Read a denomination from a coin record's denomination field: the trusted
 * twin of `findUnitBoundDenomination`. The column can only hold a
 * denomination, so looser spacing ("50 Cents") is safe as long as the whole
 * field matches end to end. Returns null for anything it doesn't fully parse.
 */
export function readTrustedDenominationText(text: string): UnitBoundDenomination | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  // "50 Cents", "20 Cents", "1 Cent", "20-cent"
  const cents = /^(\d{1,3})\s*-?\s*cents?$/i.exec(trimmed);
  if (cents) {
    const hit = CENT_FACE_VALUES[cents[1]];
    if (hit) return { ...hit, consumedTokens: tokenize(trimmed) };
  }

  /* "1¢", "5¢", "20¢", "50¢" -- the form the database seeds. Nothing else reads
   * the cent sign (`tokenize` deletes it), so without this branch such records
   * would contribute no denomination evidence. */
  const centSign = /^(\d{1,3})\s*[¢￠]$/.exec(trimmed);
  if (centSign) {
    const hit = CENT_FACE_VALUES[centSign[1]];
    if (hit) return { ...hit, consumedTokens: [centSign[1], 'cent'] };
  }

  /* "½10¢" / "1/2 10¢" / "½ Dime" -- the half dime. Without this, tokenizing
   * would leave "10" or "dime" and read it as a Dime. The `^...$` anchors on
   * the cent-sign branch above keep it from matching the trailing "10¢". */
  if (/^(?:½|1\/2)\s*-?\s*(?:10\s*[¢￠]|dimes?)$/i.test(trimmed)) {
    return { key: 'half dime', label: 'Half Dime', consumedTokens: ['half', 'dime'] };
  }

  // "½¢" / "1/2¢" -- the half cent, which has no whole-number face value.
  if (/^(?:½|1\/2)\s*[¢￠]$/.test(trimmed)) {
    return { key: 'half cent', label: 'Half Cent', consumedTokens: ['half', 'cent'] };
  }

  // "G$1" -- gold dollar. Checked before the dollar branch, which would read "$1".
  if (/^g\s*\$\s*1$/i.test(trimmed)) {
    return { key: 'gold dollar', label: 'Gold Dollar (G$1)', consumedTokens: ['gold', 'dollar'] };
  }

  /* "$20", "$2.50", "20 Dollars", "2.50 Dollars". A unit is still required: a
   * bare "20" could be cents or dollars. The amount is looked up exactly as
   * written, so "$50.00" is not a denomination. */
  const dollars =
    /^\$\s*(\d{1,2}(?:\.\d{2})?)$/i.exec(trimmed) ??
    /^(\d{1,2}(?:\.\d{2})?)\s*dollars?$/i.exec(trimmed);
  if (dollars) {
    const hit = DOLLAR_FACE_VALUES[dollars[1]];
    if (hit) return { ...hit, consumedTokens: tokenize(trimmed) };
  }

  return null;
}

/**
 * "$20" -> Double Eagle; "$25.00", "$15", "$1,250.00" -> nothing (prices).
 * Loops over every amount because one filename can carry both a face value
 * and a price ("1904 $20 Double Eagle $1,500.00.jpg").
 */
function matchDollarSign(
  rawText: string,
  wordDenominationKey: string | null
): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(DOLLAR_SIGN)) {
    // Look up the amount exactly as written: "20", "2.50", "25.00".
    const hit = DOLLAR_FACE_VALUES[match[1]];
    if (!hit) continue;

    // A coin has one face value: an amount that disagrees with the words
    // ("Peace Dollar $50") is the price.
    if (wordDenominationKey && !denominationsAgree(wordDenominationKey, hit.key)) continue;

    return { ...hit, consumedTokens: tokenize(match[0]) };
  }
  return null;
}

/** "50<cent sign>" -> Half Dollar. */
function matchCentSign(rawText: string): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(CENT_SIGN)) {
    const hit = CENT_FACE_VALUES[match[1]];
    if (hit) return { ...hit, consumedTokens: tokenize(match[0]) };
  }
  return null;
}

/** "20-cent" -> Twenty Cent. The hyphen is mandatory. */
function matchHyphenatedCent(rawText: string): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(HYPHENATED_CENT)) {
    const hit = CENT_FACE_VALUES[match[1]];
    // `match[0]` may include the leading delimiter, so tokenize the captured
    // number plus the literal word rather than the whole match.
    if (hit) return { ...hit, consumedTokens: [match[1], 'cent'] };
  }
  return null;
}

/**
 * "2 cent" -> Two Cent, "20 cent" -> Twenty Cent. Only reachable behind
 * `allowSpacedCent` (see SPACED_CENT).
 */
function matchSpacedCent(rawText: string): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(SPACED_CENT)) {
    const hit = CENT_FACE_VALUES[match[1]];
    if (hit) return { ...hit, consumedTokens: [match[1], 'cent'] };
  }
  return null;
}
