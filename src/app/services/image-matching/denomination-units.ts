/* ===========================================================================
 * denomination-units.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Reading a denomination out of a NUMBER THAT CARRIES A UNIT, straight from
 *   the raw filename: "$20", "50c" (the cent sign), "20-cent", "1-Cent".
 *   Public entry point is `findUnitBoundDenomination`.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE -- READ THIS BEFORE EDITING
 * ---------------------------------------------------------------------------
 * A **BARE** NUMBER MEANS NOTHING. A NUMBER **BOUND TO A UNIT** MEANS A LOT.
 *
 *   "25"        -> nothing. Could be a lot number, a price, a take number,
 *                  or four digits of a cert number. The matcher used to read
 *                  the "25" inside the cert number "2510345" as a quarter and
 *                  file photos under the wrong coin. That bug is why
 *                  reference-tables.ts forbids bare-digit patterns, and that
 *                  ban MUST NOT be relaxed.
 *
 *   "$20"       -> a Double Eagle. The "$" is the unit.
 *   "50<cent>"  -> a Half Dollar. The cent sign is the unit.
 *   "20-cent"   -> a Twenty Cent piece. The hyphen BINDS "20" to "cent".
 *   "3CN"       -> a Three Cent Nickel. The "CN" is the unit.
 *                  (handled by reference-tables.ts as the whole token "3cn")
 *
 * So the distinction is not "digits are bad" -- it is "digits with nothing
 * attached are bad". Everything here looks for the attachment first and reads
 * the number second.
 *
 * WHY IT RUNS ON THE RAW FILENAME
 *   Two reasons, both essential:
 *
 *   1. `tokenize` deletes every non-alphanumeric character. By the time text
 *      reaches the token list, "$20" and "20" are indistinguishable, and so
 *      are the cent sign forms. The unit is only visible BEFORE tokenizing.
 *
 *   2. The hyphen in "20-cent" is the only thing separating a real coin from
 *      a trap. Compare these two real filenames:
 *
 *          "1875-CC 20-cent Choice F - Obverse.jpg"   <- a Twenty Cent coin
 *          "Stamp - 11 - 3 cent.jpg"                  <- a postage STAMP
 *
 *      Tokenized, both contain a number next to the word "cent". Only the
 *      first HYPHENATES it. So the digit+cent rule below requires the hyphen,
 *      with no whitespace allowed. (The stamp is additionally caught by
 *      non-coin-detector.ts -- belt and braces, because getting this wrong
 *      files a stamp photo under a coin.)
 * =========================================================================== */

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

/* ---------------------------------------------------------------------------
 * THE DOLLAR TABLE
 * ---------------------------------------------------------------------------
 * ONLY the classic US gold/silver dollar face values. Anything else after a
 * "$" is a PRICE, not a denomination -- "$25.00" in
 * "1925-S Peace Dollar NGC 2510345 $25.00.jpg" is what the coin cost.
 *
 * Keys are the digits exactly as written; "2.50" keeps its decimal because the
 * Quarter Eagle is genuinely $2.50.
 * ------------------------------------------------------------------------- */
const DOLLAR_FACE_VALUES: Readonly<Record<string, { key: string; label: string }>> = {
  '1': { key: 'dollar', label: 'Dollar ($1)' },
  '2.50': { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)' },
  '3': { key: 'three dollar', label: 'Three Dollar ($3)' },
  '5': { key: 'half eagle', label: 'Half Eagle ($5)' },
  '10': { key: 'eagle', label: 'Eagle ($10)' },
  '20': { key: 'double eagle', label: 'Double Eagle ($20)' }
};

/* ---------------------------------------------------------------------------
 * THE CENT TABLE
 * ---------------------------------------------------------------------------
 * Face value in cents -> denomination. Shared by the cent-sign form ("50c")
 * and the hyphenated form ("50-Cent"), because they mean the same thing.
 * ------------------------------------------------------------------------- */
const CENT_FACE_VALUES: Readonly<Record<string, { key: string; label: string }>> = {
  '1': { key: 'cent', label: 'Cent (1c)' },
  '2': { key: 'two cent', label: 'Two Cent' },
  '3': { key: 'three cent', label: 'Three Cent' },
  '5': { key: 'nickel', label: 'Nickel (5c)' },
  '10': { key: 'dime', label: 'Dime (10c)' },
  '20': { key: 'twenty cent', label: 'Twenty Cent' },
  '25': { key: 'quarter', label: 'Quarter (25c)' },
  '50': { key: 'half dollar', label: 'Half Dollar (50c)' },
  '100': { key: 'dollar', label: 'Dollar ($1)' }
};

/* ---------------------------------------------------------------------------
 * THE PATTERNS
 * ------------------------------------------------------------------------- */

/**
 * "$20", "$ 5", "$2.50".
 *
 * The trailing `(?![\d,])` is what keeps prices out: "$1,200" would otherwise
 * match its leading "$1" and be read as a Dollar. Requiring that nothing
 * numeric follows means a thousands separator or a third digit disqualifies
 * the whole match.
 */
const DOLLAR_SIGN = /\$\s*(\d{1,2})(?:\.(\d{2}))?(?![\d,])/g;

/**
 * "50<cent sign>", "20<cent sign>". The number comes FIRST here.
 * The character class covers the real cent sign and the full-width variant
 * that occasionally survives a copy-paste.
 */
const CENT_SIGN = /(\d{1,3})\s*[¢￠]/g;

/**
 * "20-cent", "1-Cent", "50-Cent", "10-cent".
 *
 * NO WHITESPACE IS ALLOWED around the hyphen. That is the entire defence
 * against "Stamp - 11 - 3 cent.jpg"; see the header comment.
 */
const HYPHENATED_CENT = /(?:^|[^0-9a-z])(\d{1,3})-cents?(?![a-z])/gi;

/* ---------------------------------------------------------------------------
 * ENTRY POINT
 * ------------------------------------------------------------------------- */

/**
 * Look for a unit-bound denomination in the raw (extension-stripped) filename.
 *
 * Returns the FIRST form found, checked in this order:
 *   1. dollar sign      -- the least ambiguous, and the most common here
 *   2. cent sign        -- also unambiguous
 *   3. hyphenated cent  -- needs the hyphen, so it is checked last
 *
 * Returns null when no unit-bound number is present, in which case
 * filename-parser.ts falls back to the word-based table in
 * reference-tables.ts ("Half Dollar", "Morgan Dollar", "50c", "3CN").
 */
export function findUnitBoundDenomination(rawText: string): UnitBoundDenomination | null {
  return (
    matchDollarSign(rawText) ??
    matchCentSign(rawText) ??
    matchHyphenatedCent(rawText)
  );
}

/**
 * Read a denomination from a coin RECORD's own denomination field.
 *
 * This is the TRUSTED-INPUT twin of `findUnitBoundDenomination`, and the
 * asymmetry is deliberate. A filename is a free-text guess, so the rules above
 * demand a visible unit and refuse anything separated by a space. A record's
 * `denomination` COLUMN is by definition nothing but a denomination -- if it
 * says "50 Cents" there is no other thing it could mean, and no stamp, price
 * or lot number can be hiding in it.
 *
 * So here the whole field must match, anchored end to end, which makes the
 * looser spacing safe. That is what lets records written as "50 Cents",
 * "20 Cents" or "$20" line up with filenames written as "50-Cent", "20c" and
 * "$20" -- without it, half the collection's records would contribute no
 * denomination evidence at all.
 *
 * Called only when the word table in reference-tables.ts found nothing, so it
 * can never override a recognised spelling.
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

  // "$20", "$2.50", "20 Dollars", "2.50 Dollars".
  //
  // A UNIT IS STILL REQUIRED even on trusted text: either the "$" sign or the
  // word "dollar". A denomination field holding nothing but "20" is left
  // alone, because a bare number is as ambiguous in a database column as it is
  // in a filename -- twenty cents and twenty dollars are both plausible, and
  // guessing is exactly what this matcher refuses to do.
  const dollars =
    /^\$\s*(\d{1,2}(?:\.\d{2})?)$/i.exec(trimmed) ??
    /^(\d{1,2}(?:\.\d{2})?)\s*dollars?$/i.exec(trimmed);
  if (dollars) {
    const hit = DOLLAR_FACE_VALUES[dollars[1]];
    if (hit) return { ...hit, consumedTokens: tokenize(trimmed) };
  }

  return null;
}

/** "$20" -> Double Eagle. Rejects prices such as "$25.00" and "$1,200". */
function matchDollarSign(rawText: string): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(DOLLAR_SIGN)) {
    const whole = match[1];
    const cents = match[2];

    // A decimal part only ever means a real face value for $2.50. Every other
    // "$N.NN" ("$25.00", "$1.00", "$20.00") is a purchase price.
    if (cents !== undefined && !(whole === '2' && cents === '50')) continue;

    const lookupKey = cents === undefined ? whole : `${whole}.${cents}`;
    const hit = DOLLAR_FACE_VALUES[lookupKey];
    if (hit) return { ...hit, consumedTokens: tokenize(match[0]) };
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
