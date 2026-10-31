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
 *                  the "25" inside the cert number "2599001" as a quarter and
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

/* ---------------------------------------------------------------------------
 * THE DOLLAR TABLE -- AND THE ONE RULE THAT TELLS A FACE VALUE FROM A PRICE
 * ---------------------------------------------------------------------------
 * THE RULE, IN ONE SENTENCE:
 *
 *     A DOLLAR AMOUNT IN A FILENAME IS THIS COIN'S FACE VALUE ONLY IF IT IS
 *     WRITTEN EXACTLY AS ONE OF THE AMOUNTS BELOW, AND ONLY IF NOTHING ELSE IN
 *     THE NAME HAS ALREADY NAMED A DIFFERENT ONE. ANYTHING ELSE IS MONEY.
 *
 * WHY THAT IS TRUE OF COINS, AND NOT MERELY TRUE OF THIS CODE
 *   A face value is not a number somebody chose -- it is struck into the metal
 *   by a mint, and the United States has only ever struck a handful of them.
 *   The list is CLOSED and it is short: $1, $2.50, $3, $5, $10, $20, and since
 *   1986 the bullion values $25 and $50. No coin was ever denominated $15, or
 *   $37.40, or $1,250. A PRICE is the opposite kind of thing: open-ended, any
 *   amount at all, whatever this one happened to cost.
 *
 *   So the question to ask of "$N" is not "how many decimal places has it
 *   got?" but "IS THERE A COIN WORTH THAT?" -- and this table is the list of
 *   coins there are. Look the amount up; if it is not here, it is money.
 *
 * THE DECIMAL PART IS PART OF THE SPELLING, NOT A SEPARATE TEST
 *   A denomination's own cents are fixed and known, so they belong in the key:
 *   the Quarter Eagle is "2.50", the Double Eagle is "20". Looking the amount
 *   up EXACTLY AS WRITTEN therefore settles the decimals for free, with no
 *   rule about them anywhere and no exceptions to that rule:
 *
 *       "$2.50"   -> key '2.50'   present -> the Quarter Eagle
 *       "$20"     -> key '20'     present -> the Double Eagle
 *       "$20.00"  -> key '20.00'  ABSENT  -> a price. Nothing is denominated
 *                                 "twenty dollars and no cents"; spelling the
 *                                 cents out is how a person, or a spreadsheet
 *                                 export, writes MONEY.
 *       "$25.00"  -> key '25.00'  ABSENT  -> a price, even now that $25 is a
 *                                 real denomination.
 *       "$15"     -> key '15'     ABSENT  -> a price. There is no $15 coin.
 *       "$1,250"  -> no match at all: the `(?![\d,])` lookahead in DOLLAR_SIGN
 *                                 refuses a thousands separator before the
 *                                 lookup is ever reached.
 *
 *   $2.50 USED TO BE A NAMED EXCEPTION here -- the code asked whether cents
 *   were written and then whitelisted the Quarter Eagle by hand. It needs no
 *   exception now, because it was never an exception to begin with: it is
 *   simply one of the amounts a US coin is worth, and the table is what says
 *   so.
 *
 *   This is the SAME question `readTrustedDenominationText` further down this
 *   file has always asked of a coin record's denomination column. Both sides
 *   of the matcher now answer it the same way, out of the same table.
 *
 * AND THE SECOND HALF OF THE SENTENCE: A COIN HAS ONLY ONE FACE VALUE
 *   A round amount with no cents can still be a price -- "$50" for a coin that
 *   cost fifty dollars. Nothing in the digits can separate that from the $50
 *   Gold Eagle, because the two are written identically. But a filename very
 *   often says what the coin IS in words, and since a coin has exactly one
 *   face value, a dollar amount that disagrees with the words is a SECOND,
 *   different amount -- which is to say, the price:
 *
 *       "1925-S Peace Dollar $25.00.jpg"  the words say a dollar; $25 is not
 *                                         a dollar, so it is what he paid
 *       "1881-S Morgan Dollar $50.jpg"    the same, and this one is why the
 *                                         clause earns its keep: the amount IS
 *                                         in the table, and only the word
 *                                         "Dollar" gives it away as a price
 *       "2015 $25 Gold Eagle.jpg"         "Eagle" is compatible with $25 (the
 *                                         half-ounce), so this is not a second
 *                                         amount -- it is one coin stated
 *                                         twice, and the amount, being the
 *                                         more precise of the two, wins
 *
 *   "Disagrees" is decided by `denominationsAgree` in reference-tables.ts --
 *   the one table the whole matcher consults for "are these the same coin?" --
 *   so this clause inherits every alias and every generic/specific pair agreed
 *   there instead of forming a second opinion of its own.
 *
 * WHAT IS STILL OPEN, STATED HONESTLY
 *   A round price in a filename that names NO denomination in words --
 *   "1881-S Morgan $50 - Obverse.jpg" -- is still read as a face value. There
 *   is genuinely nothing in that name to tell the two apart: the evidence is
 *   absent rather than misread. The exposure is as old as "$1", "$5" and
 *   "$20", and in this collection the denomination is written first and the
 *   price, where there is one at all, carries its cents.
 * ------------------------------------------------------------------------- */
const DOLLAR_FACE_VALUES: Readonly<Record<string, { key: string; label: string }>> = {
  '1': { key: 'dollar', label: 'Dollar ($1)' },
  '2.50': { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)' },
  '3': { key: 'three dollar', label: 'Three Dollar ($3)' },
  '5': { key: 'half eagle', label: 'Half Eagle ($5)' },
  '10': { key: 'eagle', label: 'Eagle ($10)' },
  '20': { key: 'double eagle', label: 'Double Eagle ($20)' },

  /* $25 and $50 EXIST ONLY ON MODERN BULLION -- the half-ounce and one-ounce
   * American Gold Eagle (1986-), and the equivalent Platinum/Palladium Eagle
   * sizes. No circulating US coin was ever denominated at either value, which
   * is why these two rows are new and why server/setup-database.sql has no
   * matching Denominations row for them. */
  '25': { key: 'twenty five dollar', label: 'Twenty-Five Dollar ($25)' },
  '50': { key: 'fifty dollar', label: 'Fifty Dollar ($50)' }
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
  /* FIVE CENTS IS A FACE VALUE, NOT A COIN. "5c" / "5<cent sign>" could be a
   * silver Half Dime or a copper-nickel Nickel, so it maps to the GENERIC key
   * 'five cent' and never straight to 'nickel'. reference-tables.ts declares
   * 'five cent' equivalent to either specific, so nothing that used to match
   * stops matching -- but a Half Dime filed under "5<cent sign>" (which the
   * owner says happens, and which is the only five-cent row the database
   * seeds) is no longer vetoed against its own photographs. */
  '5': { key: 'five cent', label: 'Five Cent (5c)' },
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
 * "$20", "$ 5", "$2.50", "$25.00" -- ANY dollar amount, captured whole.
 *
 * It deliberately does not judge the amount. The single capture group hands
 * back the digits exactly as written, cents and all, and `matchDollarSign`
 * decides what they mean by looking them up in DOLLAR_FACE_VALUES. Keeping
 * those two jobs apart is the point: the pattern finds money, and the table
 * says whether that money is a coin.
 *
 * The trailing `(?![\d,])` is the one judgement it does make, and it is about
 * SHAPE rather than value: "$1,200" would otherwise match its leading "$1" and
 * be read as a Dollar. Requiring that nothing numeric follows means a
 * thousands separator or a third digit disqualifies the whole match, so a
 * four-figure price can never pose as a one-figure coin.
 */
const DOLLAR_SIGN = /\$\s*(\d{1,2}(?:\.\d{2})?)(?![\d,])/g;

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
 * "2 CENT", "3 CENT", "20 CENT" -- THE SPACED FACE VALUE
 * ---------------------------------------------------------------------------
 * THE OWNER WAS ASKED DIRECTLY whether a number followed by a SPACE and the
 * word "cent" is one of his face values. His answer, verbatim:
 *
 *     "Yes, read them as face values"
 *
 * He does write "2 cent", "3 cent" and "20 cent", and until now the matcher
 * read every one of them as NO DENOMINATION AT ALL. (Before that it read them
 * as a ONE CENT piece, which was worse: a wrong denomination is a hard veto,
 * so a two-cent photograph was disqualified from its own two-cent record and
 * vanished out of the import. See `isCountedCentTrap` in text-tokens.ts for
 * that story.)
 *
 * ---------------------------------------------------------------------------
 * THE DEFENCE THIS WOULD BREAK, AND HOW IT IS KEPT
 * ---------------------------------------------------------------------------
 * The hyphen requirement on HYPHENATED_CENT above is documented as "the entire
 * defence" against this real filename:
 *
 *     Stamp - 11 - 3 cent.jpg        a POSTAGE STAMP
 *
 * and the corpus holds two more of the same family:
 *
 *     3-cent paper - Large.jpg       FRACTIONAL CURRENCY, not a coin
 *     3-cent Fractional - FR1227.jpg the same, with its catalogue number
 *
 * Accepting the spaced form without a replacement guard would re-admit the
 * first of those. So the spaced form is NOT accepted unconditionally. It is
 * accepted only when the CALLER has already established that the filename
 * describes a single coin, which it does by passing `allowSpacedCent: true`,
 * and the only caller that ever passes it -- filename-parser.ts -- sets it
 * from `detectNonCoin(rawText).isNonCoin === false`.
 *
 * In other words the hyphen is no longer carrying the defence on its own; the
 * NON-COIN DETECTOR is, and the hyphen rule stays exactly as it was for every
 * caller that has not been cleared. That is a strictly better arrangement
 * than the one it replaces, because the detector reads the words that
 * actually say what the thing is -- "stamp", "paper", "fractional", "bond",
 * "note", "currency" -- rather than inferring it from punctuation:
 *
 *     Stamp - 11 - 3 cent.jpg          "stamp"      -> non-coin -> refused
 *     3-cent paper - Large.jpg         "paper"      -> non-coin -> refused
 *     3-cent Fractional - FR1227.jpg   "fractional" -> non-coin -> refused
 *     1866 2 cent - PCGS PF64RB.jpg    nothing      -> a coin    -> ACCEPTED
 *
 * TWO MORE GUARDS COME FOR FREE, and both matter:
 *
 *   A FOUR-DIGIT YEAR CANNOT MATCH. The capture is `\d{1,3}` with
 *   `[^0-9a-z]` required in front, so "1870 Cent - Obverse.jpg" offers no
 *   one-to-three-digit number that is not preceded by another digit. That
 *   filename goes on being read as a one-cent coin struck in 1870, which is
 *   what it is.
 *
 *   THE WORDS STILL WIN WHEN THEY ARE SHARPER. "1866 3 cent silver" reads
 *   here as the vague 'three cent', but filename-parser.ts prefers the word
 *   table's 'three cent silver' whenever one is a specific form of the other
 *   (`isSpecificFormOf`). The spaced reader therefore cannot blunt a filename
 *   that names the metal.
 * ------------------------------------------------------------------------- */
const SPACED_CENT = /(?:^|[^0-9a-z])(\d{1,3})\s+cents?(?![a-z])/gi;

/**
 * "½10¢" -- the HALF DIME, written as half of a dime.
 *
 * The owner: "Half Dime can be ½10¢ or 5¢". It is an odd-looking notation but
 * it is literal: a half dime is half of ten cents.
 *
 * THIS MUST BE TRIED BEFORE `CENT_SIGN`, and that is the only reason it is a
 * separate pattern. CENT_SIGN reads `(\d{1,3})\s*¢`, which sees the "10¢" at
 * the end of "½10¢" and happily reports a DIME -- twice the face value and
 * the wrong coin. Matching the fraction first consumes the whole thing.
 *
 * `½` is the single Unicode character; "1/2 10¢" is accepted too because a
 * keyboard without the glyph is the obvious way to type it.
 */
const HALF_DIME_SIGN = /(?:½|1\/2)\s*10\s*[¢￠]/;

/**
 * "G$1" -- a GOLD dollar, as opposed to the silver kind.
 *
 * The owner: "There are Gold $1 coins too but should have the word Gold in
 * the descriptor or possibly G$1." The word form ("Gold Dollar") is handled
 * by DENOMINATION_RULES; this is the abbreviation, which cannot be, because
 * tokenizing deletes the "$" and leaves the meaningless pair ['g','1'].
 *
 * TRIED BEFORE `DOLLAR_SIGN` for the same reason as the half dime above:
 * DOLLAR_SIGN would match the "$1" inside "G$1" and report the generic
 * 'dollar'. That would not be a disaster -- 'dollar' is generic over 'gold
 * dollar', so the two would still agree -- but it throws away the one piece
 * of information the "G" was there to add.
 *
 * The leading `(?:^|[^a-z0-9])` stops it firing inside a longer word, and the
 * trailing lookahead stops "G$1,200" (a price) from being read as a coin.
 */
const GOLD_DOLLAR_SIGN = /(?:^|[^a-z0-9])g\s*\$\s*1(?![\d.,])/i;

/* ---------------------------------------------------------------------------
 * ENTRY POINT
 * ------------------------------------------------------------------------- */

/**
 * Look for a unit-bound denomination in the raw (extension-stripped) filename.
 *
 * Returns the FIRST form found, checked in this order:
 *   1. "G$1"            -- MUST precede the plain dollar sign, which would
 *                          otherwise swallow the "$1" and lose the "G"
 *   2. dollar sign      -- the least ambiguous, and the most common here
 *   3. "1/2 10<cent>"   -- MUST precede the plain cent sign, which would
 *                          otherwise read its "10<cent>" as a DIME
 *   4. cent sign        -- also unambiguous
 *   5. hyphenated cent  -- needs the hyphen, so it is checked last
 *   6. SPACED cent      -- "2 cent", "20 cent". Last of all, and only when
 *                          the caller has cleared the filename of being a
 *                          stamp / paper / fractional note; see SPACED_CENT
 *
 * Steps 1 and 3 are both "a longer spelling that CONTAINS a shorter one", and
 * both are placed ahead of the form they contain. That is the same
 * most-specific-first discipline DENOMINATION_RULES follows, for the same
 * reason: the shorter pattern would win otherwise and quietly give a
 * different coin.
 *
 * Returns null when no unit-bound number is present, in which case
 * filename-parser.ts falls back to the word-based table in
 * reference-tables.ts ("Half Dollar", "Morgan Dollar", "50c", "3CN").
 *
 * @param wordDenominationKey what the WORD table makes of the same filename,
 *        if anything: 'dollar' for "Peace Dollar", 'gold eagle' for "Gold
 *        Eagle". The DOLLAR rule alone consults it, and only to throw out an
 *        amount that contradicts the words -- a coin has one face value, so a
 *        second, different one is the price. See the dollar-table header.
 *        A caller with no word opinion passes null and gets the table rule on
 *        its own. The cent forms ignore it entirely: nobody prices a coin at
 *        "50<cent sign>", so there is nothing there to be confused about.
 * @param options.allowSpacedCent say YES only once you know this filename
 *        describes a single coin. It admits the owner's spaced face values
 *        ("2 cent", "20 cent") and it is the one thing standing between the
 *        matcher and "Stamp - 11 - 3 cent.jpg", so the default is NO and the
 *        only caller that turns it on is filename-parser.ts, which turns it
 *        on from `detectNonCoin(...).isNonCoin === false`. The whole argument
 *        is in the SPACED_CENT comment above; read it before changing this.
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

  // Last, and only on a filename the caller has already cleared of being a
  // stamp, a piece of fractional currency or anything else that is not a coin.
  return options.allowSpacedCent ? matchSpacedCent(rawText) : null;
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

  /* "1¢", "5¢", "20¢", "50¢" -- THE FORM THE DATABASE ACTUALLY USES.
   *
   * server/setup-database.sql seeds the US denominations as '½¢', '1¢', '2¢',
   * '5¢', '10¢', '20¢', '25¢', '50¢', '3CS', '3CN' and the dollar values. The
   * abbreviations and the dollar forms were already understood, but the cent
   * SIGN was not: `tokenize` deletes the sign (leaving a bare "20", which the
   * word table rightly refuses) and the "N Cents" pattern above wants the
   * word spelled out. So every record holding a cent-sign denomination used
   * to contribute NO denomination evidence at all -- which also means the
   * denomination veto could never fire for one.
   *
   * Safe here for the same reason the spaced forms are: this is a record's
   * denomination COLUMN, the whole field must match end to end, and there is
   * nothing else a field reading "20¢" could be. The equivalent FILENAME form
   * is handled by `matchCentSign` above, where the stricter rules apply. */
  const centSign = /^(\d{1,3})\s*[¢￠]$/.exec(trimmed);
  if (centSign) {
    const hit = CENT_FACE_VALUES[centSign[1]];
    if (hit) return { ...hit, consumedTokens: [centSign[1], 'cent'] };
  }

  /* "½10¢" / "1/2 10¢" / "½ Dime" -- THE HALF DIME.
   *
   * The owner: "Half Dime can be ½10¢ or 5¢". The "5¢" spelling needs nothing
   * here: it goes through CENT_FACE_VALUES above to the generic 'five cent',
   * which reference-tables.ts already declares equivalent to 'half dime'.
   * The "½10¢" spelling DOES need a line, for two reasons:
   *
   *   1. nothing else would read it. `tokenize` throws the "½" and the "¢"
   *      away and leaves the bare token "10", which the word table rightly
   *      refuses; and
   *   2. worse than nothing, the cent-sign branch ABOVE would match the
   *      trailing "10¢" and report a DIME. That is why this test has to come
   *      before it -- it does not, textually, so the `^...$` anchors are what
   *      keep them apart: "½10¢" does not match `^(\d{1,3})\s*[¢￠]$`
   *      because of the leading fraction. Anchoring is doing real work here,
   *      not just tidiness.
   *
   * "½ Dime" is accepted in the same breath because a record typed by hand
   * is as likely to say that, and tokenizing it leaves ['dime'] -- which the
   * word table reads as a TEN cent piece. Same wrong answer, same fix. */
  if (/^(?:½|1\/2)\s*-?\s*(?:10\s*[¢￠]|dimes?)$/i.test(trimmed)) {
    return { key: 'half dime', label: 'Half Dime', consumedTokens: ['half', 'dime'] };
  }

  // "½¢" / "1/2¢" -- the half cent, which has no whole-number face value and
  // so cannot live in CENT_FACE_VALUES with the others.
  if (/^(?:½|1\/2)\s*[¢￠]$/.test(trimmed)) {
    return { key: 'half cent', label: 'Half Cent', consumedTokens: ['half', 'cent'] };
  }

  /* "G$1" -- a GOLD dollar. See GOLD_DOLLAR_SIGN above for the owner's rule.
   * Checked before the dollar branch below, which would read the "$1" and
   * report the generic 'dollar'. */
  if (/^g\s*\$\s*1$/i.test(trimmed)) {
    return { key: 'gold dollar', label: 'Gold Dollar (G$1)', consumedTokens: ['gold', 'dollar'] };
  }

  /* "$20", "$2.50", "20 Dollars", "2.50 Dollars".
   *
   * A UNIT IS STILL REQUIRED even on trusted text: either the "$" sign or the
   * word "dollar". A denomination field holding nothing but "20" is left
   * alone, because a bare number is as ambiguous in a database column as it
   * is in a filename -- twenty cents and twenty dollars are both plausible,
   * and guessing is exactly what this matcher refuses to do.
   *
   * NOTE THE LOOKUP: the captured amount goes into DOLLAR_FACE_VALUES exactly
   * as written, cents included. That is the same closed-set question the
   * filename side now asks, from the same table, which is why a record column
   * reading "$50.00" has never been a denomination either. */
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
 * "$20" -> Double Eagle. "$25.00", "$15" and "$1,250.00" -> nothing, because
 * they are prices. The rule and the numismatics behind it are in the
 * DOLLAR_FACE_VALUES header above; these are the two lines that apply it.
 *
 * WHY IT LOOPS over every amount rather than reading the first one. One
 * filename can carry both -- "1904 $20 Double Eagle $1,500.00.jpg" -- so the
 * loop lets the tests below take the amount that IS a coin and walk past the
 * one that is not, whichever order the two were written in.
 */
function matchDollarSign(
  rawText: string,
  wordDenominationKey: string | null
): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(DOLLAR_SIGN)) {
    /* The amount EXACTLY AS WRITTEN -- "20", "2.50", "25.00" -- because the
     * spelling is the question: is there a coin worth precisely this? */
    const hit = DOLLAR_FACE_VALUES[match[1]];
    if (!hit) continue;

    /* There is a coin worth it. But if the filename has already named a
     * DIFFERENT coin in words, this is a second amount, and a coin has only
     * one face value -- so the second one is the price. ("Peace Dollar $50".)
     * Agreement, not equality: "$25" beside the word "Gold Eagle" is the same
     * coin said twice, and the amount is the more precise of the two. */
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
 * "2 cent" -> Two Cent, "20 cent" -> Twenty Cent. The owner: "Yes, read them
 * as face values."
 *
 * Identical to `matchHyphenatedCent` except that the binder is whitespace
 * instead of a hyphen, which is exactly why it is reachable only behind
 * `allowSpacedCent`. See the SPACED_CENT comment for the stamp it would
 * otherwise let through and for the guard that replaces the hyphen.
 */
function matchSpacedCent(rawText: string): UnitBoundDenomination | null {
  for (const match of rawText.matchAll(SPACED_CENT)) {
    const hit = CENT_FACE_VALUES[match[1]];
    if (hit) return { ...hit, consumedTokens: [match[1], 'cent'] };
  }
  return null;
}
