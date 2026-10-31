/* ===========================================================================
 * reference-tables.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The matcher's DICTIONARIES -- pure, unchanging lookup data:
 *     - the denomination table (what words mean which face value),
 *     - the US mint marks (codes, spelled-out city names, friendly labels),
 *     - the token filters (stop words, camera prefixes, grading services,
 *       and the grade shorthand pattern).
 *
 * WHY IT IS ITS OWN FILE
 *   This is knowledge about COINS, not about matching. It is also the part of
 *   the matcher that grows: every time the collection gains a denomination or
 *   a filename habit we have not seen before, a line gets added here and
 *   nothing else has to change. Keeping the data separate from the algorithms
 *   means "teach the matcher a new word" is a one-file, zero-logic edit.
 *
 *   Nothing in here has behaviour except the tiny `mintLabel` lookup helper,
 *   which lives beside MINT_LABELS because it is just a friendlier way to read
 *   that same table.
 *
 *   ORDER MATTERS in DENOMINATION_RULES -- see the comment block above it.
 * =========================================================================== */

import { PHOTO_NOISE_WORDS } from './filename-vocabulary';

/* ---------------------------------------------------------------------------
 * DENOMINATION TABLE
 * ---------------------------------------------------------------------------
 * Ordered MOST SPECIFIC FIRST. The first rule whose pattern appears as a run of
 * consecutive tokens wins.
 *
 * Two hard rules here, both fixing real defects:
 *
 *  1. Patterns are arrays of WHOLE TOKENS, never substrings. This is why a
 *     cert number "2599001" can no longer be read as a quarter ("25") and why
 *     the word "center" can no longer be read as a cent.
 *
 *  2. No pattern is a BARE DIGIT. "25", "10" and "5" on their own mean nothing
 *     in a filename -- they could be a price, a lot number, or part of a date.
 *     Digits only count when paired with a unit ("20 dollar") or written in
 *     the standard collector shorthand ("25c", "10c", "5c").
 *
 *     Read rule 2 carefully before adding anything: the rule is NOT "digits
 *     are forbidden", it is "digits with NO UNIT ATTACHED are forbidden". A
 *     number bound to a unit is one of the strongest signals in this
 *     collection, which is why ['20','dollar'], ['50c'] and ['3cn'] are all
 *     fine while ['20'], ['50'] and ['3'] would be bugs. The sign-and-hyphen
 *     forms that tokenizing destroys ("$20", "50<cent sign>", "20-cent") are
 *     handled one layer earlier, in denomination-units.ts.
 *
 * Eagles: Silver Eagle, Gold Eagle, Double Eagle ($20), Half Eagle ($5),
 * Quarter Eagle ($2.50) and the plain Eagle ($10) are FIVE DIFFERENT
 * denominations. The old code collapsed every "eagle" into "dollar". They are
 * separate keys here, and the more specific ones are listed first so they win.
 *
 * ---------------------------------------------------------------------------
 * "EAGLE" IS TWO COINS 50 YEARS APART, AND THE YEAR IS WHAT TELLS THEM APART
 * ---------------------------------------------------------------------------
 * The owner, asked about the modern bullion series:
 *
 *   "It's true that a modern Gold Eagle actually refers to the $50 bullion
 *    coin, but that should be easy to determine because of the modern year
 *    (they only were minted starting in 1986)."
 *
 * He is right, and the numbers are worth writing down because nobody reading
 * this code in a year's time will remember them:
 *
 *   THE CLASSIC SERIES -- struck from gold, circulating money, ENDED IN 1933
 *     Eagle           $10     1795-1933
 *     Double Eagle    $20     1850-1933
 *     Half Eagle      $5      1795-1929
 *     Quarter Eagle   $2.50   1796-1929
 *   (President Roosevelt's 1933 gold recall is why the whole family stops in
 *    the same year. No US gold coin for circulation was struck after it.)
 *
 *   THE MODERN SERIES -- "American Gold Eagle" bullion, BEGAN IN 1986
 *     1/10 oz   $5        1986-
 *     1/4  oz   $10       1986-
 *     1/2  oz   $25       1986-
 *     1    oz   $50       1986-
 *
 * THE GAP IS THE WHOLE TRICK. 1934 to 1985 -- fifty-two years -- contains no
 * gold Eagle of either kind. So unlike EVERY other ambiguous pair in this file
 * (Half Dime vs Nickel overlap 1866-1873, 3CS vs 3CN overlap 1865-1873, Large
 * vs Small Cent overlap 1856-1857), the two Eagle series NEVER overlap, and a
 * single four-digit year separates them with no guessing whatsoever:
 *
 *     year <= 1933   ->  the classic piece
 *     year >= 1986   ->  the modern bullion piece
 *     no year        ->  WE DO NOT KNOW, and we do not guess (see below)
 *
 * HOW THAT IS IMPLEMENTED HERE. The table below cannot see a year -- it only
 * sees words -- so the word "Eagle" (with or without "Gold" in front of it)
 * resolves to the DELIBERATELY VAGUE key 'gold eagle', meaning "an Eagle of
 * some series". `resolveEagleSeries` further down this file is then handed
 * that key together with the year, and swaps it for the real one. Both parsers
 * call it: filename-parser.ts and coin-signature.ts.
 *
 * NOTE WHAT STAYS PUT. "$10", "Ten Dollar" and "10 Dollar" keep the key
 * 'eagle' and are NEVER re-resolved, because a stated face value is not
 * ambiguous -- "$10" means ten dollars whichever century struck it. Only the
 * WORD is vague, so only the word goes through the year.
 *
 * ---------------------------------------------------------------------------
 * TWO SPELLINGS, ONE KEY -- WHERE THE OWNER'S "ALIAS" RULES ARE IMPLEMENTED
 * ---------------------------------------------------------------------------
 * The owner, verbatim:
 *
 *   "Silver Eagle only refers to $1, where a (Gold) Eagle is $10 and a (Gold)
 *    Double Eagle is $20, a (Gold) Half Eagle is $5, and a (Gold) Quarter
 *    Eagles is $2.50."
 *
 * Four of those five are STRAIGHT ALIASES -- two names for one face value,
 * fully interchangeable in both directions -- and they need NO entry in
 * DENOMINATION_EQUIVALENCES below, because they are already handled HERE, in
 * the strongest possible way: both spellings produce THE SAME KEY.
 *
 *     "Double Eagle"  and "$20"    -> key 'double eagle'
 *     "Half Eagle"    and "$5"     -> key 'half eagle'
 *     "Quarter Eagle" and "$2.50"  -> key 'quarter eagle'
 *     "Half Dime"     and "1/2 10<cent sign>" -> key 'half dime'
 *
 * "Eagle" and "$10" USED to be on that list and no longer are, for the reason
 * in the block above: since 1986 the bare word can also mean a $50 bullion
 * coin, so it is parsed to the vague key 'gold eagle' and resolved by year.
 * A DATED classic Eagle still ends up on exactly the same key as "$10" --
 * `resolveEagleSeries` puts it there -- so for every coin the owner actually
 * holds the alias behaves as it always did. It is only the UNDATED word that
 * now stops short.
 *
 * The word forms come from the patterns in this table; the sign forms come
 * from DOLLAR_FACE_VALUES / CENT_FACE_VALUES in denomination-units.ts. Two
 * spellings collapsing to one key is a better alias than an equivalence row,
 * because `===` already agrees and nothing downstream has to look anything up.
 *
 * The ONE alias that cannot be done this way is Silver Eagle <-> $1, because
 * the Silver Eagle has to keep its own key (it is NOT the $10 gold Eagle, and
 * it is NOT a Morgan). That one is a row in DENOMINATION_EQUIVALENCES.
 * ------------------------------------------------------------------------- */
export interface DenominationRule {
  /** Canonical key -- two denominations agree only if their keys are equal. */
  key: string;
  /** Friendly label for the UI. */
  label: string;
  /** Each entry is a sequence of consecutive tokens that identifies this rule. */
  patterns: string[][];
}

export const DENOMINATION_RULES: readonly DenominationRule[] = [
  /* --- eagles in a metal OTHER than gold ---------------------------------
   * These must precede every gold-eagle rule below, because each of them
   * contains the token "eagle" and the bare ['eagle'] pattern further down
   * would otherwise swallow them. A Silver Eagle is ONE DOLLAR; see the long
   * "SILVER EAGLE IS NOT THE EAGLE" warning further down this file. */
  { key: 'silver eagle', label: 'Silver Eagle ($1 bullion)', patterns: [['silver', 'eagle'], ['ase']] },
  { key: 'platinum eagle', label: 'Platinum Eagle (bullion)', patterns: [['platinum', 'eagle']] },
  { key: 'palladium eagle', label: 'Palladium Eagle (bullion)', patterns: [['palladium', 'eagle']] },

  /* --- $25 and $50: the two face values the modern bullion series added ---
   *
   * Until 1986 no circulating US coin was ever denominated $25 or $50, which
   * is why these two rows did not exist before and why the database seed (see
   * server/setup-database.sql) still has no row for them. The half-ounce
   * American Gold Eagle is $25 and the one-ounce is $50, so a collection that
   * contains either needs the matcher to recognise them.
   *
   * ORDER: ['twenty','five','dollar'] MUST come before the Half Eagle's
   * ['five','dollar'], because the tokens of "Twenty Five Dollar" CONTAIN the
   * run ['five','dollar']. First rule whose pattern appears wins, so if Half
   * Eagle were tried first a $25 coin would be filed as a $5 one. This is the
   * same most-specific-first discipline the Three Cent Nickel block relies on.
   *
   * NO BARE-DIGIT PATTERN HERE EITHER. ['25','dollar'] and ['50','dollar']
   * need the word "dollar" next to the number, exactly like the ['20','dollar']
   * above them. The "$25" / "$50" sign forms are read one layer earlier by
   * denomination-units.ts, which is also where the rule that keeps "$50" the
   * DENOMINATION apart from "$50.00" the PRICE lives: an amount is a face
   * value only if it is spelled exactly as one of the amounts a US coin is
   * actually worth, and only if the filename has not already named a
   * different one in words. */
  {
    key: 'twenty five dollar',
    label: 'Twenty-Five Dollar ($25)',
    patterns: [['twenty', 'five', 'dollar'], ['25', 'dollar']]
  },
  {
    key: 'fifty dollar',
    label: 'Fifty Dollar ($50)',
    patterns: [['fifty', 'dollar'], ['50', 'dollar']]
  },

  // --- classic US gold: the NAMED multiples of the Eagle ---
  // Each of these names its own size, so none of them is ambiguous between
  // the two series the way the bare word "Eagle" is.
  { key: 'double eagle', label: 'Double Eagle ($20)', patterns: [['double', 'eagle'], ['twenty', 'dollar'], ['20', 'dollar']] },
  { key: 'half eagle', label: 'Half Eagle ($5)', patterns: [['half', 'eagle'], ['five', 'dollar'], ['5', 'dollar']] },
  { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)', patterns: [['quarter', 'eagle']] },

  /* --- THE WORD "EAGLE": AMBIGUOUS UNTIL A YEAR RESOLVES IT ---------------
   *
   * "Eagle" and "Gold Eagle" both land here, on a key that deliberately
   * commits to NOTHING: it could be the classic $10 piece (1795-1933) or any
   * of the four modern bullion sizes (1986-). See the long block at the top
   * of this file for the two date ranges and the 52-year gap between them.
   *
   * `resolveEagleSeries` (below) turns this key into a real one as soon as a
   * year is available -- 'eagle' for a classic date, 'fifty dollar' for a
   * modern one. If there is NO year it stays exactly as it is, and the
   * equivalence table makes it agree with every face value it could be, so
   * that an undated "Eagle" photo vetoes nothing.
   *
   * IT MUST SIT BELOW double / half / quarter eagle. ['eagle'] is a run of
   * one token and appears inside "Double Eagle", "Half Eagle" and "Quarter
   * Eagle", so putting it any higher would turn every one of them into this. */
  {
    key: 'gold eagle',
    label: 'Eagle (series undetermined)',
    patterns: [['gold', 'eagle'], ['eagle']]
  },

  /* The $10 FACE VALUE, as opposed to the word. A stated face value is never
   * ambiguous -- "$10" means ten dollars whoever struck it -- so these
   * spellings go straight to the classic key and are never re-resolved.
   * (A modern 1/4 oz Gold Eagle is also $10 and also lands here, correctly:
   * it really does have that face value. The YEAR veto, not this table, is
   * what stops a 1996 quarter-ounce from matching a 1907 Eagle record.) */
  { key: 'eagle', label: 'Eagle ($10)', patterns: [['ten', 'dollar'], ['10', 'dollar']] },

  /* --- dollars (specific dollar types before the generic one) -----------
   *
   * THREE different one-dollar coins live here, and the owner told us how to
   * tell them apart from the words alone:
   *
   *   "Trade Dollar can be $1 but usually the words Trade Dollar will be in
   *    the descriptor ... There are Gold $1 coins too but should have the
   *    word Gold in the descriptor or possibly G$1."
   *
   * So 'trade dollar', 'gold dollar' and 'silver dollar' are the SPECIFIC
   * forms and the plain 'dollar' at the bottom of this table is the GENERIC
   * one. A record or filename that merely says "$1" has not chosen between
   * them, and DENOMINATION_EQUIVALENCES below says so. The three specifics
   * genuinely conflict with each other: a gold dollar (1849-1889, 1.67g of
   * gold) and a Trade Dollar (1873-1885, 27.2g of silver, struck for the
   * China trade) are not remotely the same coin.
   *
   * "G$1" never reaches this table -- the "$" is destroyed by tokenizing, so
   * it is read from the raw text by denomination-units.ts instead. */
  { key: 'trade dollar', label: 'Trade Dollar', patterns: [['trade', 'dollar']] },
  { key: 'gold dollar', label: 'Gold Dollar (G$1)', patterns: [['gold', 'dollar']] },
  { key: 'silver dollar', label: 'Silver Dollar', patterns: [['silver', 'dollar']] },
  { key: 'three dollar', label: 'Three Dollar ($3)', patterns: [['three', 'dollar'], ['3', 'dollar']] },
  { key: 'half dollar', label: 'Half Dollar (50c)', patterns: [['half', 'dollar'], ['halfdollar'], ['50c'], ['fifty', 'cent']] },

  // --- minor silver / base metal ---
  { key: 'quarter', label: 'Quarter (25c)', patterns: [['quarter', 'dollar'], ['quarter'], ['25c']] },
  /* HALF DIME -- a SILVER five-cent piece, 1792-1873, and a different coin
   * from the copper-nickel five-cent "nickel" that replaced it. Both are
   * five cents, which is why 'five cent' below is generic over the pair.
   * The owner records one as either "1/2 10<cent sign>" or "5<cent sign>";
   * the first of those is read by denomination-units.ts, the second lands on
   * the generic 'five cent'. */
  { key: 'half dime', label: 'Half Dime', patterns: [['half', 'dime']] },
  { key: 'dime', label: 'Dime (10c)', patterns: [['dime'], ['10c']] },
  { key: 'twenty cent', label: 'Twenty Cent', patterns: [['twenty', 'cent'], ['20c']] },

  /*
   * THREE CENT: real filenames use the collector abbreviations "3CN" and
   * "3CS" ("1865 3CN - Choice VF - Obverse - Photo.jpg"). Both survive
   * tokenizing intact -- one token, three characters, so `singularize` leaves
   * them alone -- so listing them here is all that is needed.
   *
   * They are separate KEYS from the generic 'three cent' because the silver
   * trime and the copper-nickel three-cent piece are DIFFERENT COINS. But a
   * filename often writes only the generic form, so 'three cent' is declared
   * EQUIVALENT to either specific one in DENOMINATION_EQUIVALENCES below --
   * see that table for the owner's rule and the asymmetry it encodes. The two
   * specific keys never agree with each other.
   *
   * WHY THIS BLOCK SITS ABOVE 'nickel', AND WHY THAT MATTERS
   *   It used to sit below it, and the result was a silent and quite serious
   *   bug: a coin record whose denomination reads "Three Cent Nickel"
   *   tokenizes to ['three','cent','nickel'], the generic ['nickel'] rule
   *   matched first, and the record was filed as a FIVE CENT PIECE. Every
   *   3CN photo then disagreed on denomination with its own record. The rule
   *   at the top of this table -- MOST SPECIFIC FIRST -- is not a style
   *   preference; ['three','cent','nickel'] is strictly more specific than
   *   ['nickel'] and must be tried before it.
   *
   * THE DIGIT SPELLINGS, AND THE BUG THEY FIX
   *   The owner reported that his 1867 Three Cent NICKEL record was being
   *   offered photographs of his 1867 Three Cent SILVER proof -- two coins
   *   the denomination veto is supposed to keep apart absolutely. The cause
   *   was here. He writes the three in digits at least as often as in words:
   *
   *       1864 3-cent silver - PF64 - Obverse.jpg   -> ['3','cent','silver']
   *       1866 3 cent silver PF65 - Obverse.jpg     -> ['3','cent','silver']
   *
   *   and the only spellings listed were the WORD forms, so a name that said
   *   "silver" in so many letters came out as the vague 'three cent' (which
   *   is compatible with a 3CN record, so no veto fired) or -- worse, via
   *   the bare ['cent'] rule far below -- as a ONE CENT piece.
   *
   *   Listing the digit forms is not a loosening. It is the opposite: the
   *   more specific the key, the more conflicts the veto can see, and a
   *   filename that states the metal outright should never be read as though
   *   it had not. ['3','cent','silver'] is strictly more specific than
   *   ['cent'], so by this table's own first rule it belongs above it.
   *
   *   Note the digit forms are only listed WITH a metal word. A bare
   *   "3 cent" / "3-cent" still means the vague 'three cent' and is handled
   *   by denomination-units.ts, which deliberately insists on the hyphen as
   *   its defence against "Stamp - 11 - 3 cent.jpg". Nothing here changes
   *   that.
   */
  {
    key: 'three cent nickel',
    label: 'Three Cent Nickel (3CN)',
    patterns: [
      ['3cn'],
      ['three', 'cent', 'nickel'], ['nickel', 'three', 'cent'],
      ['3', 'cent', 'nickel'], ['nickel', '3', 'cent']
    ]
  },
  {
    key: 'three cent silver',
    label: 'Three Cent Silver (3CS)',
    patterns: [
      ['3cs'],
      ['three', 'cent', 'silver'], ['silver', 'three', 'cent'],
      ['3', 'cent', 'silver'], ['silver', '3', 'cent'],
      ['trime']
    ]
  },
  { key: 'three cent', label: 'Three Cent', patterns: [['three', 'cent'], ['3c']] },

  /*
   * FIVE CENTS: a GENERIC face value and a SPECIFIC coin, split apart.
   *
   * 'five cent' is the bare face value -- "5c", "5<cent sign>", "Five Cent".
   * It says the coin is worth five cents and NOTHING ELSE, because the United
   * States struck two quite different five-cent pieces:
   *
   *     HALF DIME   1792-1873   silver, tiny, 1.24g
   *     NICKEL      1866-       copper-nickel, much larger
   *
   * So a record reading "5<cent sign>" -- which is exactly what
   * server/setup-database.sql seeds, and the owner says a Half Dime of his
   * may well be filed under it -- has not said which coin it is. That is the
   * same shape as the three-cent case above, and it is handled the same way:
   * 'five cent' is declared GENERIC over both in DENOMINATION_EQUIVALENCES.
   *
   * WHY THIS IS NOT A CONTRADICTION. "Half Dime and Nickel are both 5 cents"
   * sounds like the table disagreeing with itself. It is not: FACE VALUE and
   * COIN are two different facts, and two different coins may share one face
   * value. The years overlap from 1866 to 1873 -- both were struck in those
   * eight years -- so the date cannot separate them either, exactly as with
   * 3CS and 3CN. The generic must match either; the two specifics must never
   * match each other.
   *
   * 'nickel' (the specific coin) stays LAST of the three-cent family so that
   * "Three Cent Nickel" can never be read as a five-cent piece. See the block
   * above for the bug that rule exists to prevent.
   */
  { key: 'five cent', label: 'Five Cent (5c)', patterns: [['5c'], ['five', 'cent']] },
  { key: 'nickel', label: 'Nickel (5c)', patterns: [['nickel']] },

  { key: 'two cent', label: 'Two Cent', patterns: [['two', 'cent'], ['2c']] },
  { key: 'half cent', label: 'Half Cent', patterns: [['half', 'cent']] },

  /*
   * ONE CENT: the same generic/specific split once more.
   *
   *     LARGE CENT  1793-1857   copper, 28-29mm -- the size of a half dollar
   *     SMALL CENT  1856-       the Flying Eagle / Indian Head / Lincoln cent
   *
   * The owner: "Large Cent is also 1<cent sign>." Both ARE one cent, so a
   * record or filename saying only "1<cent sign>" is compatible with either,
   * while a stated Large Cent and a stated Small Cent are different coins and
   * conflict. 'cent' below is therefore the GENERIC key, and these two are
   * its specifics -- see DENOMINATION_EQUIVALENCES.
   *
   * 'small cent' is listed even though the words are rare in a filename,
   * because without a key for it the owner's rule has only one specific and
   * nothing for a Large Cent to conflict WITH.
   */
  { key: 'large cent', label: 'Large Cent', patterns: [['large', 'cent']] },
  { key: 'small cent', label: 'Small Cent', patterns: [['small', 'cent']] },
  { key: 'cent', label: 'Cent (1c)', patterns: [['cent'], ['penny'], ['1c'], ['one', 'cent']] },

  // --- generic dollar last so "half dollar" / "trade dollar" win first ---
  { key: 'dollar', label: 'Dollar ($1)', patterns: [['dollar'], ['one', 'dollar'], ['1', 'dollar'], ['100c']] }
];

/* ===========================================================================
 * WHEN TWO DIFFERENT KEYS STILL MEAN ONE COIN
 * ---------------------------------------------------------------------------
 * The product owner, verbatim, first time:
 *
 *   "Also note that 3¢ can be equivalent to 3CS or 3CN for any matches for
 *    pulling in coin inventory and grabbing coin details or image matching to
 *    inventory."
 *
 * and then, answering the follow-up questions:
 *
 *   "Large Cent is also 1¢. Half Dime can be ½10¢ or 5¢; Trade Dollar can be
 *    $1 but usually the words Trade Dollar will be in the descriptor; Silver
 *    Eagle only refers to $1, where a (Gold) Eagle is $10 and a (Gold) Double
 *    Eagle is $20, a (Gold) Half Eagle is $5, and a (Gold) Quarter Eagles is
 *    $2.50. There are Gold $1 coins too but should have the word Gold in the
 *    descriptor or possibly G$1."
 *
 * ---------------------------------------------------------------------------
 * THERE ARE TWO DIFFERENT SHAPES OF RULE IN THERE. THEY ARE NOT THE SAME.
 * ---------------------------------------------------------------------------
 *
 *  A. AN ALIAS. Two names for ONE face value, fully interchangeable, in both
 *     directions, with nothing left to disagree about:
 *
 *         Silver Eagle  ==  $1
 *
 *     Most of the owner's aliases never reach this table at all, because
 *     DENOMINATION_RULES and denomination-units.ts already give both
 *     spellings THE SAME KEY -- "Eagle" and "$10" are both 'eagle', "Double
 *     Eagle" and "$20" are both 'double eagle', and so on. See the long
 *     comment above DENOMINATION_RULES. Only Silver Eagle needs a row, and
 *     only because it must keep its own key (below).
 *
 *  B. A GENERIC OVER ITS SPECIFICS. One vague key that could be any of
 *     several real coins. The generic agrees with EVERY specific, and the
 *     specifics NEVER agree with EACH OTHER:
 *
 *         3¢  over  3CS / 3CN
 *         1¢  over  Large Cent / Small Cent
 *         5¢  over  Half Dime / Nickel
 *         $1  over  Gold Dollar / Silver Dollar / Trade Dollar
 *
 *     This is the shape that matters most, because getting it wrong is costly
 *     in both directions (see "THE ASYMMETRY" below).
 *
 * The practical difference: an alias has no losers -- nobody conflicts with
 * anybody. A generic group creates conflicts on purpose, between its own
 * specifics.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP: "SILVER EAGLE" IS ONE DOLLAR, NOT TEN AND NOT TWENTY
 * ---------------------------------------------------------------------------
 * This is the single easiest thing in this file to get wrong, so it is
 * written out in full.
 *
 *   EAGLE          the classic US gold ten-dollar piece, 1795-1933.
 *   HALF EAGLE     $5 gold.      DOUBLE EAGLE   $20 gold.
 *   QUARTER EAGLE  $2.50 gold.
 *
 *   SILVER EAGLE   the modern American Silver Eagle bullion coin, 1986-.
 *                  One ounce of silver, worth far more than a dollar in
 *                  metal, but its FACE VALUE -- the only thing a
 *                  denomination field records -- is ONE DOLLAR.
 *
 * So "Silver Eagle" is a dollar coin that happens to have the word "Eagle" in
 * its name. It must NEVER collapse into 'eagle': a Silver Eagle photograph
 * landing on a $10 gold Eagle record would be a four-figure mistake. The two
 * keys stay separate and `denominationsAgree('silver eagle', 'eagle')` is
 * FALSE. There is a test with exactly that name.
 *
 * AND NOTE WHAT CHANGED ABOUT 'gold eagle'. It used to agree with nothing at
 * all, on the grounds that "Gold Eagle" might be the classic $10 piece or any
 * of the four modern bullion sizes ($5 / $10 / $25 / $50) and there was no way
 * to tell. The owner supplied the way to tell -- the year -- so the key is now
 * the HONEST MIDDLE STATE: it means "an Eagle whose series we have not
 * established yet", and it appears only when no usable year was available.
 * It is a shape-B generic over every face value such a coin could carry, so
 * it agrees with all of them and vetoes none of them. See its row below.
 *
 * WHAT IS GOING ON -- THE SAME STORY, FOUR TIMES OVER
 *   The United States repeatedly struck TWO (or three) quite different coins
 *   at one face value. The face value is what a denomination field records;
 *   the coin is what the photograph shows. They are not the same fact.
 *
 *     ONE CENT    Large Cent  1793-1857  copper, 28-29mm
 *                 Small Cent  1856-      Flying Eagle / Indian / Lincoln
 *
 *     THREE CENT  3CS "trime" 1851-1873  silver
 *                 3CN         1865-1889  copper-nickel
 *
 *     FIVE CENT   Half Dime   1792-1873  silver, tiny
 *                 Nickel      1866-      copper-nickel, much larger
 *
 *     ONE DOLLAR  Gold Dollar   1849-1889  1.67g gold ("G$1")
 *                 Silver Dollar 1794-      Morgan, Peace, Seated...
 *                 Trade Dollar  1873-1885  27.2g, struck for the China trade
 *
 *   In every case a RECORD may say which one it is -- 3CS and 3CN are seeded
 *   as separate denominations in server/setup-database.sql -- or may say only
 *   the face value, because '1¢', '5¢' and '$1' are the only rows the seed
 *   offers for those three. A FILENAME very often says only the face value
 *   too: "1851 3-cent - VF - Obverse.jpg" just says three cents.
 *
 * THE RULE, AND ITS ASYMMETRY
 *   For a group-B entry the equivalence runs GENERIC-TO-SPECIFIC ONLY:
 *
 *     'three cent'  <-> 'three cent silver'    equivalent, no conflict
 *     'three cent'  <-> 'three cent nickel'    equivalent, no conflict
 *     'three cent silver' <-> 'three cent nickel'   A GENUINE CONFLICT
 *
 *   Getting it wrong in either direction is costly, and in opposite ways:
 *
 *     - Collapse all three into one bucket and a silver trime starts matching
 *       a nickel three-cent. Different metals, different decades, different
 *       money.
 *     - Treat the generic form as conflicting with the specific one and the
 *       denomination veto throws away a CORRECT match. That is the specific
 *       failure the owner is pre-empting here.
 *
 *   THE YEAR CANNOT RESCUE YOU -- FOR THESE FOUR GROUPS. Every one of these
 *   pairs OVERLAPS in time: 3CS and 3CN share 1865-1873; Half Dime and Nickel
 *   share 1866-1873; Large Cent and Small Cent share 1856-1857; the three
 *   dollars share 1873-1885.
 *   So "the dates will separate them" is false in exactly the years where a
 *   mistake is possible.
 *
 *   THE EAGLE IS THE ONE EXCEPTION, and that is exactly why it gets different
 *   treatment. The classic gold Eagle stopped in 1933 and the modern bullion
 *   Gold Eagle started in 1986, so there is a 52-year gap and no year can
 *   belong to both. That is what makes `resolveEagleSeries` safe when the
 *   same trick would be reckless for every group above. Do not generalise it.
 *
 *   A metal or size word in the text ("silver",
 *   "nickel", "large") does separate them, and when one is present the parser
 *   has already produced the SPECIFIC key via DENOMINATION_RULES above -- so
 *   that disambiguation is a refinement that happens earlier, not a
 *   requirement here.
 *
 * WHY THE GROUPS ARE NOT TRANSITIVE, AND WHY THAT IS CORRECT
 *   'silver eagle' is an ALIAS of 'dollar', and 'dollar' is GENERIC over
 *   'trade dollar'. A reader might expect that to make a Silver Eagle match a
 *   Trade Dollar. It does not, and must not: `denominationsAgree` consults
 *   each row independently and never chains them. A 1986 bullion coin and an
 *   1878 China-trade coin are not the same coin, however the arrows line up.
 *
 * WHY THE TABLE LIVES IN THIS FILE
 *   It is coin knowledge, so it belongs beside DENOMINATION_RULES. More
 *   importantly it has to be the SINGLE source of truth: the scorer, the
 *   near-match test, the hard veto and anything in the import paths that
 *   compares two denominations all call `denominationsAgree` rather than
 *   `===`. Two tables that can drift would eventually disagree about whether
 *   a photo belongs to a coin.
 *
 * ADDING TO THIS TABLE
 *   DO NOT GUESS. A wrong equivalence is worse than a missing one, because it
 *   silently attaches a photo to the wrong coin whereas a missing one merely
 *   sends the pair to review. Add a group only when the generic form genuinely
 *   cannot mean anything except one of the listed specifics.
 *
 *   And pick the right SHAPE before you write the row. Ask: "if both sides
 *   name a member of this group, and they name DIFFERENT members, is that a
 *   conflict?" If yes it is a generic group (shape B). If no -- if the two
 *   names are simply two ways of writing one face value -- it is an alias
 *   (shape A), and check first whether the two spellings can just be given
 *   the same key in DENOMINATION_RULES instead, which is simpler still.
 * ========================================================================= */

/**
 * SHAPE A -- two names for one face value, fully interchangeable.
 *
 * Every key in `names` agrees with every other key in `names`, in both
 * directions, and none of them conflicts with any of the others. There is no
 * "more specific" member: that is the whole difference from shape B.
 */
export interface DenominationAlias {
  kind: 'alias';
  /** Interchangeable keys. Order is irrelevant. */
  names: readonly string[];
  /** Plain English, for the reader rather than the code. */
  why: string;
}

/**
 * SHAPE B -- one vague key standing over the real coins it might be.
 *
 * `generic` agrees with every entry in `specific`. The entries in `specific`
 * NEVER agree with each other; that disagreement is the point of the group.
 */
export interface DenominationGeneric {
  kind: 'generic';
  /** The vague key, e.g. 'three cent'. */
  generic: string;
  /** The precise keys. These never agree with EACH OTHER. */
  specific: readonly string[];
  /** Plain English, for the reader rather than the code. */
  why: string;
}

/** One row of the single shared equivalence table, of either shape. */
export type DenominationEquivalence = DenominationAlias | DenominationGeneric;

/**
 * THE ONE TABLE. The veto, the scorer and the near-match test all reach this
 * through `denominationsAgree`; none of them holds a rule of its own.
 */
export const DENOMINATION_EQUIVALENCES: readonly DenominationEquivalence[] = [
  /* ---------------------------------------------------------------------
   * A. ALIASES
   * -------------------------------------------------------------------
   * Only one row, and the comment above DENOMINATION_RULES explains why:
   * every other alias the owner listed ("Eagle" = "$10", "Double Eagle" =
   * "$20", "Half Eagle" = "$5", "Quarter Eagle" = "$2.50", "Half Dime" =
   * "½10¢") is already resolved to a single key by the parse tables, which
   * is a stronger guarantee than a row here could give.
   * ------------------------------------------------------------------- */
  {
    kind: 'alias',
    names: ['silver eagle', 'dollar'],
    why:
      'The owner: "Silver Eagle only refers to $1". The American Silver Eagle ' +
      'bullion coin (1986-) carries a ONE DOLLAR face value, so a record ' +
      'filed under "$1" and a filename saying "Silver Eagle" are the same ' +
      'coin, in either direction. It is NOT the $10 gold Eagle and it is NOT ' +
      'the $20 Double Eagle; those keep their own keys and conflict with this ' +
      'one, which is the point of giving the Silver Eagle a key at all.'
  },

  /* ---------------------------------------------------------------------
   * B. GENERIC OVER SPECIFICS
   * -------------------------------------------------------------------
   * In each row the generic matches anything; the specifics fight.
   * ------------------------------------------------------------------- */
  {
    kind: 'generic',
    generic: 'three cent',
    specific: ['three cent silver', 'three cent nickel'],
    why:
      'A filename writing "3¢" / "3 Cent" / "3C" does not say whether it is ' +
      'the 1851-1873 silver trime or the 1865-1889 copper-nickel piece, but a ' +
      'record always does. The generic form is compatible with either; the two ' +
      'specific forms are different coins and are never compatible with each other.'
  },
  {
    kind: 'generic',
    generic: 'cent',
    specific: ['large cent', 'small cent'],
    why:
      'The owner: "Large Cent is also 1¢". The copper Large Cent (1793-1857) ' +
      'and the Small Cent that replaced it (1856-) share the one-cent face ' +
      'value and nothing else -- different size, different metal, different ' +
      'coin. "1¢" is compatible with either; a stated Large Cent and a stated ' +
      'Small Cent conflict.'
  },
  {
    kind: 'generic',
    generic: 'five cent',
    specific: ['half dime', 'nickel'],
    why:
      'The owner: "Half Dime can be ½10¢ or 5¢". The silver Half Dime ' +
      '(1792-1873) and the copper-nickel Nickel (1866-) are both five-cent ' +
      'coins, and they were struck alongside each other from 1866 to 1873, so ' +
      'the year cannot always separate them. "5¢" -- which is the only ' +
      'five-cent row the database seeds -- is compatible with either; a stated ' +
      'Half Dime and a stated Nickel are different coins and conflict.'
  },
  {
    /* THE UNDATED EAGLE.
     *
     * 'gold eagle' is produced ONLY by the bare word "Eagle" / "Gold Eagle"
     * with no usable year beside it. `resolveEagleSeries` replaces it the
     * moment a year is available, so by the time this row is consulted we
     * genuinely do not know which of the two series is in the photograph.
     *
     * The honest specific list is "every face value an Eagle can carry":
     *
     *     classic Eagle        $10   1795-1933   -> 'eagle'
     *     modern 1/10 oz       $5    1986-       -> 'half eagle'
     *     modern 1/4  oz       $10   1986-       -> 'eagle'
     *     modern 1/2  oz       $25   1986-       -> 'twenty five dollar'
     *     modern 1    oz       $50   1986-       -> 'fifty dollar'
     *
     * so four distinct keys. $20 (Double Eagle) and $2.50 (Quarter Eagle) are
     * NOT in the list: neither series ever put those values on a coin called
     * simply "Eagle", and both have their own unmistakable name.
     *
     * WHY GENERIC AND NOT ALIAS. Being generic means this key agrees with all
     * four and therefore vetoes none of them, while the four go on conflicting
     * with each other exactly as they did before -- a $5 Half Eagle record
     * still conflicts with a "$50" filename. That is the asymmetry the shape-B
     * rows exist for, and it is the safe direction to be wrong in: the cost of
     * a too-wide generic is a photo that needs a human glance, whereas the
     * cost of a missing equivalence is the denomination veto silently throwing
     * away a correct match.
     *
     * In practice this row should almost never fire, because nearly every
     * filename in this collection carries a year. */
    kind: 'generic',
    generic: 'gold eagle',
    specific: ['eagle', 'half eagle', 'twenty five dollar', 'fifty dollar'],
    why:
      'The owner: "a modern Gold Eagle actually refers to the $50 bullion ' +
      'coin, but that should be easy to determine because of the modern year ' +
      '(they only were minted starting in 1986)." When the year IS there, ' +
      'resolveEagleSeries uses it and this row is never reached. When it is ' +
      'NOT there the word "Eagle" could be the classic $10 piece or any of ' +
      'the four modern bullion sizes ($5, $10, $25, $50), so it is treated as ' +
      'the generic form of all four rather than being guessed at.'
  },
  {
    kind: 'generic',
    generic: 'dollar',
    specific: ['gold dollar', 'silver dollar', 'trade dollar'],
    why:
      'The owner: "Trade Dollar can be $1 but usually the words Trade Dollar ' +
      'will be in the descriptor... There are Gold $1 coins too but should ' +
      'have the word Gold in the descriptor or possibly G$1." So a bare "$1" ' +
      'has not chosen between the three one-dollar coins and must not veto any ' +
      'of them, while a filename or record that DOES name one (gold, silver, ' +
      'trade) has chosen, and the three choices conflict with each other.'
  }
];

/**
 * Do these two denomination keys describe the same coin?
 *
 * Use this ANYWHERE two denominations are compared. Plain `===` would reject
 * the alias and generic/specific pairs above and veto correct matches.
 *
 * DELIBERATELY NOT TRANSITIVE. Each row is checked on its own and the rows are
 * never chained, so 'silver eagle' == 'dollar' and 'dollar' ~ 'trade dollar'
 * do NOT combine into 'silver eagle' ~ 'trade dollar'. See the header.
 *
 * A missing value on either side is NOT agreement -- it is no evidence at all,
 * and the "absence is not agreement" rule means the caller must handle that
 * case itself rather than being told the two agree.
 */
export function denominationsAgree(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) return false;
  if (left === right) return true;

  return DENOMINATION_EQUIVALENCES.some(group =>
    group.kind === 'alias'
      ? group.names.includes(left) && group.names.includes(right)
      : (group.generic === left && group.specific.includes(right)) ||
        (group.generic === right && group.specific.includes(left))
  );
}

/**
 * True when the two keys agree WITHOUT being identical -- i.e. they agree
 * because of a row in the table above rather than because the two sides wrote
 * the same thing.
 *
 * Used purely to word the explanation honestly ("Three Cent is the general
 * form of Three Cent Silver") rather than claiming an exact match. The
 * sentence is phrased for the common case, shape B; the single alias row
 * (Silver Eagle / $1) also comes through here and reads acceptably in the
 * "$1 is the general form of Silver Eagle" direction.
 */
export function denominationsAgreeLoosely(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return denominationsAgree(left, right) && left !== right;
}

/**
 * True when `specific` is one of the precise coins that `generic` stands over
 * -- 'three cent silver' under 'three cent', 'half dime' under 'five cent'.
 *
 * WHY THIS IS A QUESTION WORTH ASKING
 *   Two readers look at every filename: the WORD table above, and the
 *   face-value reader in denomination-units.ts. Normally a stated face value
 *   is the better evidence and wins. But a face value can only ever say HOW
 *   MANY CENTS, and for three cents and five cents that is not enough to name
 *   the coin:
 *
 *       1864 3-cent silver - PF64 - Obverse.jpg
 *            ^^^^^^ the reader sees "three cents"
 *                   ^^^^^^ the words say WHICH three-cent coin
 *
 *   Letting the face value win there threw the word "silver" away and
 *   produced the vague 'three cent', which is compatible with a Three Cent
 *   NICKEL record -- so the denomination veto never fired and the owner was
 *   offered his 3CN for a photograph of his 3CS. This predicate is how
 *   filename-parser.ts knows to keep the sharper of the two answers.
 *
 *   It is strictly a sharpening: the two keys already AGREE (that is what
 *   makes one the generic of the other), so no pairing that used to match
 *   stops matching. What changes is that the specific key can now CONFLICT
 *   with the other specific, which is exactly what it is for.
 */
export function isSpecificFormOf(
  specific: string | null | undefined,
  generic: string | null | undefined
): boolean {
  if (!specific || !generic) return false;
  return DENOMINATION_EQUIVALENCES.some(
    group => group.kind === 'generic' && group.generic === generic && group.specific.includes(specific)
  );
}

/* ===========================================================================
 * THE YEAR AS A TIE-BREAKER: WHICH EAGLE IS THIS?
 * ---------------------------------------------------------------------------
 * The owner, verbatim:
 *
 *   "It's true that a modern Gold Eagle actually refers to the $50 bullion
 *    coin, but that should be easy to determine because of the modern year
 *    (they only were minted starting in 1986)."
 *
 * THE TWO SERIES, ONE MORE TIME, BECAUSE THIS IS THE FILE A FUTURE READER
 * WILL OPEN:
 *
 *   CLASSIC GOLD EAGLE        $10        struck 1795 - 1933
 *       Real circulating money, 16.72 g of .900 gold. The whole US gold
 *       coinage ends in 1933 with the gold recall; nothing was struck for
 *       circulation afterwards.
 *
 *   AMERICAN GOLD EAGLE       bullion    struck 1986 - present
 *       Sold by weight, not spent. Four sizes, each with a nominal face
 *       value nobody would ever actually use:
 *           1/10 oz -> $5     1/4 oz -> $10
 *           1/2  oz -> $25    1   oz -> $50
 *
 *   1934 - 1985: NOTHING. Fifty-two years with no gold Eagle of either kind.
 *
 * THAT GAP IS WHY THIS IS SAFE AND NOT A GUESS. There is no year that could
 * belong to both series, so a four-digit date decides the question outright.
 * Contrast every other ambiguous pair in this file -- Half Dime vs Nickel,
 * 3CS vs 3CN, Large vs Small Cent -- where the two coins were struck
 * ALONGSIDE each other and the year is worthless. Do not copy this technique
 * to those; see the "THE YEAR CANNOT RESCUE YOU" block above.
 *
 * AND WHEN THERE IS NO YEAR WE STOP. An undated "Eagle" keeps the vague
 * 'gold eagle' key, which the equivalence table makes compatible with every
 * face value it could be, so it disqualifies nothing. Refusing to answer is
 * the correct answer; inventing a series would attach a photo of a $2,500
 * bullion coin to a $20,000 classic coin, or the reverse.
 * ========================================================================= */

/** First year of the American Gold Eagle bullion series. Nothing before it. */
export const GOLD_EAGLE_BULLION_FIRST_YEAR = 1986;

/** Last year any classic US gold coin was struck (Roosevelt's gold recall). */
export const CLASSIC_GOLD_LAST_YEAR = 1933;

/** The vague key the word "Eagle" / "Gold Eagle" parses to before resolution. */
export const UNRESOLVED_EAGLE_KEY = 'gold eagle';

/** What an unqualified modern "Gold Eagle" means: the one-ounce, $50 coin. */
const MODERN_EAGLE_DEFAULT = { key: 'fifty dollar', label: 'Gold Eagle 1 oz ($50)' };

/** What a classic-dated Eagle means: the $10 gold piece. */
const CLASSIC_EAGLE = { key: 'eagle', label: 'Eagle ($10)' };

/* ---------------------------------------------------------------------------
 * THE OPTIONAL REFINEMENT: A WEIGHT WORD NAMES THE EXACT SIZE
 * ---------------------------------------------------------------------------
 * Only the ONE OUNCE coin is called a "Gold Eagle" unqualified -- that is the
 * owner's "$50" and it is the default above. The three fractional sizes are
 * normally written with their fraction ("1/4 oz Gold Eagle") or with their own
 * face value ("$10"), and when the fraction IS written it tells us the face
 * value exactly. So this is a refinement on top of the year, never a
 * substitute for it: it is consulted only once the year has already said
 * "modern".
 *
 * ORDERED MOST SPECIFIC FIRST, like every other table in this file. "1 oz"
 * must be tried last or it would claim the "1" at the front of "1/10 oz".
 *
 * WHY EACH FRACTION ACCEPTS "/", "-" AND "_", AND ALSO THE SINGLE GLYPH.
 * A FILENAME CANNOT CONTAIN A FORWARD SLASH -- it is the path separator, and
 * `baseName` in text-tokens.ts splits on it, so "2015 1/2 oz Eagle.jpg" would
 * arrive here as "2 oz Eagle.jpg" with the year already lost. Anyone writing
 * a fraction into a file name therefore writes "1-2 oz", "1_2 oz" or the
 * single character "½". The slash form is still accepted because the other
 * caller is a coin RECORD, whose coinType and variety columns hold ordinary
 * text and keep their slashes.
 *
 * NOTE ON THE FRACTIONAL KEYS. 1/10 oz is $5 and maps to 'half eagle'; 1/4 oz
 * is $10 and maps to 'eagle'. Those are the CLASSIC keys, and that is
 * deliberate and correct: the face value really is the same, and the owner's
 * own CSV template files a 1996 Gold Eagle under "$5". Sharing the key is what
 * lets a modern bullion photo match a record seeded with the existing "$5" or
 * "$10" row. The YEAR VETO in match-vetoes.ts, not this table, is what keeps a
 * 1996 tenth-ounce away from an 1899 Half Eagle record.
 * ------------------------------------------------------------------------- */
const GOLD_EAGLE_SIZES: ReadonlyArray<{ pattern: RegExp; key: string; label: string }> = [
  { pattern: /(?:1\s*[/\-_]\s*10|⅒)\s*(?:oz|ounce)/i, key: 'half eagle', label: 'Gold Eagle 1/10 oz ($5)' },
  { pattern: /(?:1\s*[/\-_]\s*4|¼)\s*(?:oz|ounce)/i, key: 'eagle', label: 'Gold Eagle 1/4 oz ($10)' },
  { pattern: /(?:1\s*[/\-_]\s*2|½)\s*(?:oz|ounce)/i, key: 'twenty five dollar', label: 'Gold Eagle 1/2 oz ($25)' },
  { pattern: /(?:^|[^0-9/\-_])1\s*(?:oz|ounce)/i, key: 'fifty dollar', label: 'Gold Eagle 1 oz ($50)' }
];

/**
 * Turn the vague 'gold eagle' key into a real face value, using the year.
 *
 * THE ONE PLACE this decision is made. Both parsers call it -- the filename
 * parser and the coin-record parser -- so neither side can form its own
 * opinion about which series a coin belongs to.
 *
 * It is a no-op for every key except 'gold eagle'. In particular it never
 * touches 'eagle', 'half eagle', 'double eagle' or 'quarter eagle': those
 * came from a STATED face value or a self-describing name and are not
 * ambiguous, so re-reading them against the year would be meddling.
 *
 * @param denomination what the word/sign tables produced (may be null)
 * @param year         the year the same parser read, or null if it read none
 * @param text         the raw text, searched for a weight word as a refinement
 *
 * The four outcomes:
 *
 *   no year            -> unchanged. WE DO NOT GUESS. The equivalence table
 *                         makes the vague key agree with everything it could
 *                         be, so nothing is vetoed on its account.
 *   year <= 1933       -> the classic $10 Eagle.
 *   year >= 1986       -> the modern bullion coin: the size named by a weight
 *                         word if there is one, otherwise the unqualified
 *                         meaning, which the owner gives as the $50 one-ouncer.
 *   1934 .. 1985       -> unchanged. No gold Eagle exists with such a date, so
 *                         the year is telling us something is wrong (most
 *                         likely it is not really the coin's mint year) and
 *                         the honest answer is still "we do not know".
 */
export function resolveEagleSeries<T extends { key: string; label: string }>(
  denomination: T | null,
  year: number | null,
  text = ''
): T | { key: string; label: string } | null {
  if (!denomination || denomination.key !== UNRESOLVED_EAGLE_KEY) return denomination;
  if (year === null) return denomination;

  if (year <= CLASSIC_GOLD_LAST_YEAR) return CLASSIC_EAGLE;

  if (year >= GOLD_EAGLE_BULLION_FIRST_YEAR) {
    const sized = GOLD_EAGLE_SIZES.find(size => size.pattern.test(text));
    return sized ? { key: sized.key, label: sized.label } : MODERN_EAGLE_DEFAULT;
  }

  // 1934-1985: neither series was struck. Say nothing.
  return denomination;
}

/* ---------------------------------------------------------------------------
 * MINT MARKS
 * ------------------------------------------------------------------------- */

/** Valid US mint mark codes. Anything not in here is not a mint mark. */
export const MINT_CODES = new Set(['p', 'd', 's', 'w', 'o', 'c', 'cc', 'm']);

/** Full mint names -> code. Used when a filename spells the mint out. */
export const MINT_NAMES: ReadonlyArray<{ words: string[]; code: string }> = [
  { words: ['philadelphia'], code: 'p' },
  { words: ['philly'], code: 'p' },
  { words: ['denver'], code: 'd' },
  { words: ['dahlonega'], code: 'd' },
  { words: ['san', 'francisco'], code: 's' },
  { words: ['carson', 'city'], code: 'cc' },
  { words: ['new', 'orleans'], code: 'o' },
  { words: ['west', 'point'], code: 'w' },
  { words: ['charlotte'], code: 'c' }
];

/** Friendly names for the explanation text. */
export const MINT_LABELS: Readonly<Record<string, string>> = {
  p: 'P (Philadelphia)',
  d: 'D (Denver)',
  s: 'S (San Francisco)',
  w: 'W (West Point)',
  o: 'O (New Orleans)',
  c: 'C (Charlotte)',
  cc: 'CC (Carson City)',
  m: 'M (Manila)'
};

/**
 * Friendly label for a mint code, for use in the "why" sentences.
 * Unknown codes fall back to shouting the code itself, which is better than
 * printing nothing when a record holds a mint we have not catalogued.
 */
export function mintLabel(code: string): string {
  return MINT_LABELS[code] ?? code.toUpperCase();
}

/* ---------------------------------------------------------------------------
 * TOKEN FILTERS
 * ------------------------------------------------------------------------- */

/**
 * Words that carry no information about WHICH coin this is. They are removed
 * before we compare "coin type" words, so "obverse" and "scan" cannot inflate
 * a similarity score.
 */
export const STOP_WORDS = new Set([
  // file / image words
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'heic', 'heif',
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'pics', 'picture',
  'scan', 'scanned', 'raw', 'copy', 'final', 'edited', 'crop', 'cropped',
  'screenshot', 'dsc', 'dscn', 'dscf', 'pxl', 'mvimg', 'vid',
  // coin-photo vocabulary
  'coin', 'coins', 'obverse', 'obv', 'reverse', 'rev', 'front', 'back',
  'side', 'edge', 'slab', 'holder', 'graded', 'cert', 'certified', 'certificate',
  'lot', 'item', 'no', 'num', 'number',
  // country noise
  'us', 'usa', 'united', 'states',
  // filler
  'the', 'and', 'of', 'a', 'an',

  /*
   * Everything that describes the PHOTOGRAPH or the GRADE rather than the
   * coin, pulled in from filename-vocabulary.ts: side words ("Obverse",
   * "Label"), photo qualifiers ("Photo", "Orig", "Sharpened", "Small"),
   * grade vocabulary ("VF", "Choice", "DCAM") and era markers ("BC", "CE").
   *
   * They are folded in HERE rather than filtered separately so that every
   * consumer of `meaningfulTokens` -- the filename parser AND the coin-record
   * parser -- drops them automatically and identically. If they survived,
   * two unrelated coins would look similar merely because both filenames end
   * in "- Obverse - Photo".
   *
   * Safe despite "Large Cent" and "Small Cent" being real denominations:
   * denomination detection runs on the RAW token list before stop words are
   * removed, so those rules still fire.
   */
  ...PHOTO_NOISE_WORDS
]);

/** Camera / phone filename prefixes. A number right after one of these is a
 *  sequence number, NOT a year -- this is what stops "IMG_2024.jpg" from being
 *  read as a 2024 coin.
 *
 *  "im" is here because this collection's older camera produced "IM000025.JPG".
 *
 *  "coin" is deliberately NOT here even though "Coin_026.JPG" exists: "coin"
 *  is an ordinary word that could legitimately precede a year ("Coin 1881
 *  Morgan"), and rejecting that year would cost more than it saves. The
 *  camera-default names are caught instead by non-coin-detector.ts, which
 *  requires the WHOLE filename to be a prefix plus a number. */
export const CAMERA_PREFIXES = new Set([
  'img', 'image', 'im', 'dsc', 'dscn', 'dscf', 'dscd', 'pxl', 'p',
  'photo', 'pic', 'pict', 'scan', 'screenshot', 'mvimg', 'vid', 'gopr',
  'pano', 'burst'
]);

/**
 * Third-party grading services. Recognised but not used as coin-type words.
 *
 * On its own a cert company is WEAK evidence -- hundreds of coins in one
 * collection are "PCGS". Paired with a matching grade it becomes strong; see
 * the combination rule in match-scorer.ts.
 */
export const CERT_COMPANIES = new Set([
  'ngc', 'pcgs', 'anacs', 'icg', 'cac', 'cacg', 'segs', 'nnc'
]);

/**
 * Grade shorthand as a WHOLE TOKEN, e.g. ms63, au50, pf70, xf45, vf20,
 * pf65rb, pf64cameo, pr69dcam.
 *
 * Used to keep grade tokens out of the coin-type evidence. The richer grade
 * forms that tokenizing destroys -- "VF+", "XF-AU", "Choice VF" -- are read
 * separately by grade-parser.ts, which works on the raw filename.
 *
 * The designation group is ordered LONGEST FIRST so "cameo" is never matched
 * as "cam" with a stray "eo" left over.
 */
export const GRADE_PATTERN =
  /^(ms|pf|pr|sp|au|xf|ef|vf|vg|ag|fr|po|g|f)-?(\d{1,2})(dcameo|cameo|dcam|ucam|cam|dpl|pl|rd|rb|bn|fb|fs|fh|bl|star)?$/;
