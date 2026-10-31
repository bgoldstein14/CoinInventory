/* ===========================================================================
 * metal-inference.ts — "WHAT METAL IS THIS?", ASKED ON ITS OWN
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `pm-reference.ts` answers a HARD question: *exactly* how much pure precious
 * metal does this coin contain? That needs a catalogued row — a country, a
 * denomination and a year band — because the answer is a number that feeds the
 * melt-value calculation, and it has to be the right number.
 *
 * This file answers a much EASIER question: what metal is it made of? For a
 * great many coins that is obvious from the coin's own description even when
 * the precise alloy is not catalogued at all:
 *
 *     "1927 $20 Saint-Gaudens"        -> a US $20 is gold, full stop
 *     "American Gold Eagle"           -> the type name says so out loud
 *     "1884 Morgan"                   -> every Morgan dollar is 90% silver
 *     "1913 France 20 Francs"         -> ...we have no idea. Leave it blank.
 *
 * THE DEFECT THIS WAS WRITTEN FOR
 * The owner imported a file of gold coins and reported that Metal Content was
 * not being set. The cause was that `composePmFields` was all-or-nothing: it
 * asked `lookupCoinAlloy` for the full four-field answer and, the moment that
 * found no catalogued row, returned null — so a coin whose exact weight and
 * purity were unknown ended up with no METAL either, even when the metal was
 * never in doubt. This module is the coarse fallback that fixes that half of
 * the problem without pretending to know the other half.
 *
 * ---------------------------------------------------------------------------
 * THE GOVERNING PRINCIPLE IS UNCHANGED: WHEN IN DOUBT, ANSWER NOTHING
 * ---------------------------------------------------------------------------
 * This project already follows that rule for image matching ("only assume a
 * match if it is very close, otherwise let the user decide") and for the alloy
 * table. It applies here too, and the reason is the same:
 *
 *     A WRONG METAL SILENTLY PRODUCES A CONFIDENTLY WRONG MELT VALUE.
 *     A BLANK FIELD PRODUCES AN HONEST DASH THE USER CAN FIX.
 *
 * So every rule below is a rule that is TRUE BY DEFINITION of the series or
 * the denomination, not a rule that is usually true. Where two metals shared a
 * date — the 1942 nickel, the 1982 cent, the 1971-78 Eisenhower dollar, a bare
 * "$1" in the gold-dollar era — this file answers null, exactly as
 * `pm-reference.ts` does, and for exactly the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE NEVER LOOKS AT
 * ---------------------------------------------------------------------------
 *   * `category`. A coin filed under a "Gold Coins" category is a statement
 *     about the owner's filing cabinet, not about the coin. Collections
 *     routinely contain a silver token or a copper medal in a gold folder, and
 *     letting a folder name overrule the coin itself is exactly the kind of
 *     confident wrong answer this module exists to avoid.
 *   * `notes`, `grade`, `certCompany`. Free text written for humans; "CAC Gold"
 *     alone proves how badly a metal word in free text can mislead (it is a
 *     STICKER tier, and it sits on silver coins all the time).
 *
 * ---------------------------------------------------------------------------
 * OUTPUT VOCABULARY
 * ---------------------------------------------------------------------------
 * Every value this file can return is a `CoinMetal`, which is the exact list
 * seeded into the `MetalContents` table by `server/setup-database.sql`. The
 * coin editor renders Metal as a <select> fed by that table, so a value
 * outside the list would be un-displayable and un-editable.
 * =========================================================================== */

import { CoinMetal } from './pm-reference';

/**
 * The canonical Metal values, as a runtime list.
 *
 * `CoinMetal` is a compile-time union; this is the same thing at run time, so
 * a free-text metal word can be checked against it. Kept in the same order as
 * the `INSERT INTO MetalContents` statement in `server/setup-database.sql`, so
 * the two are easy to diff by eye.
 */
export const CANONICAL_METALS: readonly CoinMetal[] = [
  'Gold',
  'Silver',
  'Platinum',
  'Palladium',
  'Copper',
  'Nickel',
  'Copper-Nickel',
  'Bronze',
  'Brass',
  'Zinc',
  'Steel',
  'Aluminum',
  'Nickel-Brass',
  'Clad',
  'Other'
] as const;

/**
 * The four metals that carry a melt value, and therefore the four this module
 * cares most about getting right. When a composition names several metals, a
 * precious one is the one the Metal Content field is really asking about —
 * see `metalFromComposition` for why that matters for the wartime nickel.
 */
const PRECIOUS_METALS: readonly CoinMetal[] = ['Gold', 'Silver', 'Platinum', 'Palladium'];

/** Everything this module is willing to read. Nothing else is consulted. */
export interface MetalEvidence {
  /** The coin's type / series, e.g. "Saint-Gaudens", "Gold Eagle", "Morgan". */
  coinType?: string;
  /** Normalised denomination, e.g. "$20", "50¢", "100 Soles". */
  denomination?: string;
  /** Year string; ranges ("1920-1930") and overdates ("1862/1") are tolerated. */
  year?: string;
  /** Country name, e.g. "United States". Gates the US-denomination rules. */
  country?: string;
  /** Free-text alloy description already recorded on the coin. */
  composition?: string;
  /**
   * A metal the CALLER has already read out of the source text — the Quicken
   * importer's `detectMetalHint` (which has already scrubbed the "CAC Gold"
   * sticker trap), or the coin's own hand-entered Metal Content. This is a
   * direct statement, not an inference, which is why it outranks everything.
   */
  metalHint?: string;
}

/** An answer, plus the name of the rule that produced it (for tests and debugging). */
export interface MetalInference {
  metal: CoinMetal;
  /** Short, stable identifier for the rule that fired. */
  rule: string;
  /** One sentence a human can read, explaining why. */
  because: string;
}

/* ===========================================================================
 * SMALL HELPERS
 * ======================================================================== */

/**
 * Reads the leading 4-digit year, tolerating the forms the parsers actually
 * produce: "1969", "1920-1930" (a range) and "1862/1" (an overdate).
 *
 * This duplicates a private helper in `pm-reference.ts` rather than importing
 * it, because that one is deliberately not exported and this module is not
 * allowed to change that file's rules. Six lines of duplication is cheaper
 * than widening another module's public surface.
 */
function parseLeadingYear(year: string | undefined): number | null {
  const match = String(year ?? '').match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Turn a free-text metal word into a canonical `CoinMetal`, or null.
 *
 * Only WHOLE values match — "Gold" yes, "goldish" no — because this is used on
 * fields that are supposed to contain a metal name and nothing else.
 */
export function canonicalMetal(text: string | undefined): CoinMetal | null {
  const normalised = String(text ?? '').trim().toLowerCase();
  if (!normalised) return null;

  const direct = CANONICAL_METALS.find((metal) => metal.toLowerCase() === normalised);
  if (direct) return direct;

  // Spellings the dropdown does not use but a human might type.
  const aliases: Record<string, CoinMetal> = {
    'cupronickel': 'Copper-Nickel',
    'cupro-nickel': 'Copper-Nickel',
    'copper nickel': 'Copper-Nickel',
    'copper-nickle': 'Copper-Nickel',
    'nickel brass': 'Nickel-Brass',
    'aluminium': 'Aluminum'
  };
  return aliases[normalised] ?? null;
}

/**
 * Normalise a denomination for comparison: upper-case, no internal spaces,
 * and no pointless trailing zero after a decimal point so that "$2.50" and
 * "$2.5" are the same denomination.
 */
function normaliseDenomination(denomination: string | undefined): string {
  let text = String(denomination ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^G?\$\d+\.\d+$/.test(text)) {
    text = text.replace(/0+$/, '').replace(/\.$/, '');
  }
  return text;
}

/** True for the United States, and for a record that simply does not say. */
function isUnitedStatesOrUnknown(country: string | undefined): boolean {
  const text = String(country ?? '').trim().toLowerCase();
  return text === '' || text === 'united states' || text === 'usa' || text === 'us';
}

/* ===========================================================================
 * RULE 1 — AN EXPLICIT METAL WORD
 * ---------------------------------------------------------------------------
 * The strongest evidence there is, because it is not an inference at all: the
 * source text, or the owner, named the metal.
 *
 * Two sources, in order:
 *
 *   a) `metalHint` — a metal the caller already extracted and vouched for. The
 *      Quicken importer produces it from the security name ("1849-O $1 Gold",
 *      "1855 G$1") and has ALREADY removed the "CAC Gold" / "Gold CAC" sticker
 *      phrase, which is a grading tier and not a metal. The Settings backfill
 *      produces it from the coin's existing Metal Content, i.e. from something
 *      the owner typed. `lookupCoinAlloy` already trusts this value enough to
 *      let it break a gold-vs-silver tie, so trusting it here is consistent.
 *
 *   b) a metal word inside the COIN TYPE — "Gold Eagle", "Silver Eagle",
 *      "Gold Dollar", "Three Cent Silver". This is the field the owner pointed
 *      at: "the coin type would have made that obvious".
 *
 * *** WHY ONLY THE FOUR PRECIOUS METALS ARE READ OUT OF A TYPE NAME ***
 * "Nickel" in a coin type is a DENOMINATION, not an alloy. A "Jefferson
 * Nickel" dated 1943 is 35% SILVER, and a "Three Cent Nickel" is 75% copper.
 * Reading the word as a metal would therefore be wrong in both directions, so
 * base-metal words in a type name are ignored entirely.
 * ======================================================================== */

/** Precious-metal words, in the order they are searched for. */
const PRECIOUS_WORD_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bgold\b/i, metal: 'Gold' },
  { pattern: /\bsilver\b/i, metal: 'Silver' },
  { pattern: /\bplatinum\b/i, metal: 'Platinum' },
  { pattern: /\bpalladium\b/i, metal: 'Palladium' }
];

/**
 * The CAC sticker scrub, repeated here as belt and braces.
 *
 * "CAC Gold" / "Gold CAC" is CAC's top sticker tier, NOT the coin's metal, and
 * it sits on silver coins all the time ("1875 20¢ - PCGS XF40 CAC Gold" is a
 * 90% silver twenty-cent piece). The Quicken importer already scrubs it before
 * producing `metalHint`; this module scrubs it again because a coin TYPE is
 * free text and could have had it pasted in.
 */
function scrubCacGoldSticker(text: string): string {
  return text
    .replace(/\bCAC\b\s*[-/]?\s*\bGold\b/gi, 'CAC')
    .replace(/\bGold\b\s*[-/]?\s*\bCAC\b/gi, 'CAC');
}

/**
 * The FIRST precious-metal word in a piece of text, or null.
 *
 * "First" is by position, not by the order of the table above, so a type
 * reading "Silver and Gold commemorative" answers Silver — the majority-first
 * convention compositions use.
 */
function firstPreciousWord(text: string): CoinMetal | null {
  const scrubbed = scrubCacGoldSticker(text);
  let best: { index: number; metal: CoinMetal } | null = null;

  for (const { pattern, metal } of PRECIOUS_WORD_PATTERNS) {
    const match = scrubbed.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.index) best = { index: match.index, metal };
  }

  return best?.metal ?? null;
}

/* ===========================================================================
 * RULE 2 — A DENOMINATION THAT IS GOLD BY DEFINITION
 * ---------------------------------------------------------------------------
 * US coinage never struck these face values in anything but gold. This is not
 * a statistical claim; it is what the Mint Acts say.
 *
 *     $20   Double Eagle, 1849-1933. The only US $20 coin ever struck, and it
 *           was always 0.900 fine gold. There is no modern $20 bullion issue.
 *     $10   Eagle, 1795-1933, and the 1/4 oz American Gold Eagle from 1986.
 *           See the CAVEAT below — this is the one that needs a year.
 *     $5    Half Eagle, 1795-1929; the 1/10 oz American Gold Eagle from 1986;
 *           and every modern US commemorative $5, all of which are gold by
 *           statute. No US $5 coin has ever been struck in anything else.
 *     $3    Three Dollar piece, 1854-1889. One series, one specification,
 *           always gold. Nothing else has ever carried a $3 face value.
 *     $2.50 Quarter Eagle, 1796-1929. Likewise gold throughout.
 *
 * *** WHY "$1" IS NOT ON THIS LIST ***
 * Because between 1849 and 1889 the United States struck BOTH a 26.73 g silver
 * dollar and a 1.672 g gold dollar, and the face value alone cannot tell them
 * apart. (Add the clad Eisenhower, the Susan B. Anthony and the manganese
 * brass Sacagawea, and "$1" has worn four different metals.) `lookupCoinAlloy`
 * refuses that case by design and so does this file. A bare "$1" gets nothing.
 *
 * A LEADING "G" IS THE COLLECTOR'S SHORTHAND for the gold issue — "G$1",
 * "G$2.50", "G$3" — and four of the owner's securities are written that way.
 * The Quicken parser normally converts that into a plain denomination plus a
 * metal hint, but the shorthand is accepted here too in case it reaches the
 * denomination field verbatim.
 *
 * *** THE CAVEAT: $10 AFTER 1986 ***
 * The modern bullion programmes reused old face values. $10 is the 1/4 oz
 * American GOLD Eagle, but it is also the 1/10 oz American PLATINUM Eagle
 * (1997 onward). Both are "a US $10". So the $10 rule is switched off from
 * 1986 — the start of the bullion era — unless some other rule (a type name
 * saying "Gold Eagle" or "Platinum Eagle") has already settled it. A record
 * with no year at all keeps the gold reading: classic Eagles outnumber tenth
 * ounce platinum by orders of magnitude, and the type-name rule catches the
 * platinum case whenever the coin is labelled at all.
 *
 * $25 and $50 are deliberately absent for the same reason, with no safe year
 * cutoff available: $50 is the 1 oz Gold Eagle, the 1 oz Gold Buffalo, the
 * 1/2 oz Platinum Eagle AND the 1915 Panama-Pacific commemorative.
 * ======================================================================== */

/** Normalised US denominations that can only ever have been struck in gold. */
const GOLD_ONLY_US_DENOMINATIONS: readonly string[] = ['$20', '$10', '$5', '$3', '$2.5'];

/** First year of the modern bullion programmes, which reused old face values. */
const BULLION_ERA_FIRST_YEAR = 1986;

/* ===========================================================================
 * RULE 3 — SERIES NAMES THAT IMPLY A METAL
 * ---------------------------------------------------------------------------
 * A series name is often more specific than a face value. "Saint-Gaudens" can
 * only be a $20 gold piece; "Morgan" can only be a silver dollar.
 *
 * *** WHY THE SILVER ENTRIES CARRY YEAR BANDS AND THE GOLD ONES DO NOT ***
 * US silver series were interrupted by the Coinage Act of 1965, which removed
 * silver from the dime and the quarter outright — a 1964 quarter is 90% silver
 * and a 1965 quarter has none — and several classic designs were later revived
 * in a DIFFERENT metal for collectors:
 *
 *     2016  gold 1/10 oz Mercury dime centennial
 *     2016  gold Standing Liberty quarter centennial
 *     2016  gold Walking Liberty half dollar centennial
 *
 * So "Mercury" on its own does NOT prove silver; "Mercury" dated 1916-1945
 * does. That is why the brief's instruction was to read the year alongside the
 * type name rather than assume. A silver rule with a year band simply declines
 * when the record has no year — which is the honest answer.
 *
 * The gold entries need no band because none of those names was ever reused:
 * there is no silver Saint-Gaudens and no base-metal Quarter Eagle.
 *
 * *** THE NAMES DELIBERATELY LEFT OFF THIS LIST ***
 * These were all considered and rejected because they name coins in more than
 * one metal, and the name alone cannot say which:
 *
 *     Liberty Head   the 5¢ nickel (cupronickel), the $20 double eagle (gold)
 *                    and the Type 1 gold dollar all use it. Only the compound
 *                    "Liberty Head Double Eagle" is safe, and that is already
 *                    covered by the "Double Eagle" entry below.
 *     Indian Head    the 1¢ (bronze), the $2.50 / $5 / $10 (gold), and the
 *                    5¢ Buffalo is often catalogued under it too.
 *     Classic Head   half cents and cents (copper) AND $2.50 / $5 (gold).
 *     Draped Bust    copper cents, silver dimes-to-dollars, gold $2.50-$10.
 *     Capped Bust    silver 10¢-50¢ AND gold $2.50 / $5.
 *     Flowing Hair   silver half dimes-to-dollars AND copper cents/half cents.
 *     Coronet        gold $2.50-$20 AND the Coronet Head large cent.
 *     Jefferson      1942-1945 war nickels are 35% silver, everything else in
 *                    the series is cupronickel, and 1942 was struck BOTH ways.
 *                    This is one of pm-reference.ts's three "deliberate gaps"
 *                    and it is inherited here unchanged.
 *     Eisenhower     1971-1978 business strikes are clad, the collector issues
 *                    of the same dates are 40% silver. The second deliberate
 *                    gap, likewise inherited.
 *     Lincoln        1982 was struck in both bronze and copper-plated zinc.
 *                    The third deliberate gap.
 *
 * In every one of those cases the DENOMINATION plus the YEAR does settle the
 * question wherever it can be settled — and that is exactly what
 * `lookupCoinAlloy` already does, before this file is ever consulted.
 * ======================================================================== */

interface SeriesRule {
  /** Matched against the coin type (whole words, case-insensitive). */
  pattern: RegExp;
  metal: CoinMetal;
  /**
   * When present, the rule only fires for a year inside this band, and NEVER
   * fires for a record with no year. Used for the US silver series, whose
   * designs were revived in gold or replaced by clad.
   */
  years?: { min: number; max: number };
  /** Why this is safe — shown in `MetalInference.because`. */
  because: string;
}

const SERIES_RULES: readonly SeriesRule[] = [
  /* --- GOLD: names never used on a coin of any other metal ---------------- */
  {
    pattern: /\bsaint[-\s]?gaudens\b|\bst\.?\s*gaudens\b/i,
    metal: 'Gold',
    because: 'the Saint-Gaudens design was only ever struck as the $20 gold double eagle'
  },
  {
    pattern: /\bdouble\s+eagle\b/i,
    metal: 'Gold',
    because: 'a Double Eagle is the US $20 gold piece, 1849-1933'
  },
  {
    pattern: /\bhalf\s+eagle\b/i,
    metal: 'Gold',
    because: 'a Half Eagle is the US $5 gold piece'
  },
  {
    pattern: /\bquarter\s+eagle\b/i,
    metal: 'Gold',
    because: 'a Quarter Eagle is the US $2.50 gold piece'
  },
  {
    // The Indian Princess design belongs to the Type 2/3 gold dollar and the
    // $3 gold piece. It was never used on a silver or base-metal coin.
    pattern: /\bindian\s+princess\b/i,
    metal: 'Gold',
    because: 'the Indian Princess design belongs to the gold dollar and the $3 gold piece'
  },
  {
    // "Gold Eagle" / "Gold Dollar" / "Gold Buffalo" are also caught by the
    // metal-word rule above; the entry is kept so the series list reads
    // completely on its own.
    pattern: /\bgold\s+(?:eagle|dollar|buffalo)\b/i,
    metal: 'Gold',
    because: 'the series name says gold'
  },

  /* --- SILVER: always silver, in every year the series ran ---------------- */
  {
    // 1878-1904 and 1921 at 90%, and the 2021-onward revival at 99.9%. Silver
    // in every year it has ever existed, so no band is needed.
    pattern: /\bmorgan\b/i,
    metal: 'Silver',
    because: 'every Morgan dollar ever struck is silver'
  },
  {
    // 1921-1935 at 90%, and the 2021-onward revival at 99.9%. Same reasoning.
    pattern: /\bpeace\b/i,
    metal: 'Silver',
    because: 'every Peace dollar ever struck is silver'
  },
  {
    pattern: /\btrade\s+dollar\b/i,
    metal: 'Silver',
    because: 'the Trade Dollar (1873-1885) is 90% silver'
  },
  {
    pattern: /\bthree\s+cent\s+silver\b|\btrime\b/i,
    metal: 'Silver',
    because: 'the three-cent silver was struck only in silver, 1851-1873'
  },

  /* --- SILVER: year-gated, because the design was later revived in gold
   *     or the denomination later went clad ------------------------------- */
  {
    pattern: /\bmercury\b/i,
    metal: 'Silver',
    years: { min: 1916, max: 1945 },
    because: 'Mercury dimes are 90% silver throughout 1916-1945 (the 2016 centennial issue is gold)'
  },
  {
    pattern: /\bstanding\s+liberty\b/i,
    metal: 'Silver',
    years: { min: 1916, max: 1930 },
    because: 'Standing Liberty quarters are 90% silver throughout 1916-1930 (the 2016 centennial issue is gold)'
  },
  {
    pattern: /\bwalking\s+liberty\b/i,
    metal: 'Silver',
    years: { min: 1916, max: 1947 },
    because: 'Walking Liberty halves are 90% silver throughout 1916-1947 (the 2016 centennial issue is gold)'
  },
  {
    pattern: /\bbarber\b/i,
    metal: 'Silver',
    years: { min: 1892, max: 1916 },
    because: 'Barber dimes, quarters and halves are 90% silver throughout 1892-1916'
  },
  {
    pattern: /\bfranklin\b/i,
    metal: 'Silver',
    years: { min: 1948, max: 1963 },
    because: 'Franklin half dollars are 90% silver throughout 1948-1963'
  },
  {
    pattern: /\bliberty\s+seated\b|\bseated\s+liberty\b/i,
    metal: 'Silver',
    years: { min: 1836, max: 1891 },
    because: 'the Liberty Seated series ran 1836-1891 and is silver in every denomination it used'
  },
  {
    // THE 1965 CLIFF. The Coinage Act of 1965 removed silver from the dime and
    // the quarter outright, so these two bands stop dead at 1964. A 1965
    // Washington quarter is clad and gets nothing from this rule.
    pattern: /\bwashington\b/i,
    metal: 'Silver',
    years: { min: 1932, max: 1964 },
    because: 'Washington quarters are 90% silver up to 1964; the Coinage Act of 1965 removed it'
  },
  {
    pattern: /\broosevelt\b/i,
    metal: 'Silver',
    years: { min: 1946, max: 1964 },
    because: 'Roosevelt dimes are 90% silver up to 1964; the Coinage Act of 1965 removed it'
  },
  {
    // The Kennedy half is the one exception to the 1965 cliff: it kept 40%
    // silver for six more years. Still "Silver" as a Metal Content, just less
    // of it — which is why the band runs to 1970 and then stops.
    pattern: /\bkennedy\b/i,
    metal: 'Silver',
    years: { min: 1964, max: 1970 },
    because: 'Kennedy halves are 90% silver in 1964 and 40% silver 1965-1970; 1971 onward are clad'
  }
];

/* ===========================================================================
 * RULE 4 — THE COMPOSITION TEXT
 * ---------------------------------------------------------------------------
 * The weakest of the four, and the only one that reads a field the user may
 * have typed freehand. It is last because a composition is usually present
 * only when somebody already filled part of this in by hand.
 *
 * *** THE TRAP THE BRIEF CALLS OUT ***
 * Composition strings name SEVERAL metals, majority first:
 *
 *     "90% Gold, 10% Copper"                        a double eagle
 *     "91.67% Gold, 8.33% Silver and Copper"        early US gold
 *     "92.5% Silver, 7.5% Copper (sterling)"        a British crown
 *
 * A naive "does it contain Copper?" test classifies all three as copper. So
 * the reading below is ordered, and each step exists for a named string:
 *
 *   1. "X-plated Y" / "X-coated Y" -> the metal is Y, the CORE, not the skin.
 *      "Copper-plated zinc (97.5% Zn, 2.5% Cu)" is a zinc cent, not a copper
 *      one; "Zinc-coated steel" is the 1943 steel cent.
 *
 *   2. A PRECIOUS metal named anywhere wins over any base metal, and if more
 *      than one is named the one with the larger percentage wins.
 *      This is what the Metal Content field is actually asking about — it
 *      feeds the melt calculation — and it is what the reference table itself
 *      does: the 1943-45 wartime nickel is "56% Copper, 35% Silver, 9%
 *      Manganese" and pm-reference.ts records its metal as SILVER, not copper,
 *      even though copper is the majority by weight.
 *
 *   3. Otherwise a named ALLOY wins over its ingredients: "Copper-Nickel clad
 *      (75% Cu / 25% Ni ...)" is Copper-Nickel, and "Manganese brass (88.5%
 *      Cu, ...)" is Brass. Reading the first ingredient instead would answer
 *      Copper for both.
 *
 *   4. Otherwise, the base metal with the largest stated percentage, and
 *      failing that the first one named — the majority-first convention.
 * ======================================================================== */

/** Compound alloy names that must be recognised before their ingredients. */
const ALLOY_NAME_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bcupro[-\s]?nickel\b|\bcopper[-\s]nickel\b/i, metal: 'Copper-Nickel' },
  { pattern: /\bnickel[-\s]brass\b/i, metal: 'Nickel-Brass' },
  { pattern: /\bbronze\b/i, metal: 'Bronze' },
  { pattern: /\bbrass\b/i, metal: 'Brass' }
];

/** Bare metal words, longest/most specific first. */
const BASE_METAL_WORD_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bcopper\b/i, metal: 'Copper' },
  { pattern: /\bnickel\b/i, metal: 'Nickel' },
  { pattern: /\bzinc\b/i, metal: 'Zinc' },
  { pattern: /\bsteel\b/i, metal: 'Steel' },
  { pattern: /\balumini?um\b/i, metal: 'Aluminum' },
  { pattern: /\bclad\b/i, metal: 'Clad' }
];

/**
 * Reads "<number>% <metal word>" pairs out of a composition and returns the
 * largest percentage recorded for each metal.
 *
 * Only the word IMMEDIATELY after the percentage counts, which is what makes
 * "91.67% Gold, 8.33% Silver and Copper" score Gold 91.67 and Silver 8.33 and
 * leave Copper unscored — Copper shares the 8.33% and is not separately
 * stated. That is the right reading: the majority metal is still Gold.
 */
function percentagesByMetal(composition: string): Map<CoinMetal, number> {
  const scores = new Map<CoinMetal, number>();
  const pattern = /(\d+(?:\.\d+)?)\s*%\s*([A-Za-z][A-Za-z-]*)/g;

  for (const match of composition.matchAll(pattern)) {
    const percent = Number.parseFloat(match[1]);
    const metal = canonicalMetal(match[2]);
    if (!metal || !Number.isFinite(percent)) continue;
    if (percent > (scores.get(metal) ?? -1)) scores.set(metal, percent);
  }

  return scores;
}

/** The first pattern in `candidates` that appears in `text`, by position. */
function firstMatchByPosition(
  text: string,
  candidates: readonly { pattern: RegExp; metal: CoinMetal }[]
): CoinMetal | null {
  let best: { index: number; metal: CoinMetal } | null = null;

  for (const { pattern, metal } of candidates) {
    const match = text.match(pattern);
    if (!match || match.index === undefined) continue;
    if (!best || match.index < best.index) best = { index: match.index, metal };
  }

  return best?.metal ?? null;
}

/**
 * The metal a composition string describes, or null when it names none.
 * See the long comment above for the four ordered steps and why each exists.
 */
export function metalFromComposition(composition: string | undefined): CoinMetal | null {
  const text = scrubCacGoldSticker(String(composition ?? '').trim());
  if (!text) return null;

  // STEP 1 — a plating or coating describes the SKIN; the second metal is the
  // coin. "Copper-plated zinc" is a zinc cent; "Zinc-coated steel" is steel.
  const plated = text.match(/\b[A-Za-z]+[-\s](?:plated|coated)\s+([A-Za-z]+)\b/i);
  if (plated) {
    const core = canonicalMetal(plated[1]);
    if (core) return core;
  }

  const scores = percentagesByMetal(text);

  // STEP 2 — a precious metal outranks any base metal, and the largest stated
  // percentage outranks a smaller one.
  const preciousScored = PRECIOUS_METALS
    .filter((metal) => scores.has(metal))
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  if (preciousScored.length > 0) return preciousScored[0];

  // ...and if the text names a precious metal with no percentage at all
  // ("sterling silver", "gold alloy"), the first one named still wins.
  const preciousWord = firstPreciousWord(text);
  if (preciousWord) return preciousWord;

  // STEP 3 — a named alloy outranks its own ingredients.
  const alloyName = firstMatchByPosition(text, ALLOY_NAME_PATTERNS);
  if (alloyName) return alloyName;

  // STEP 4 — the base metal with the largest stated percentage, else the
  // first one named (the majority-first convention these strings follow).
  const baseScored = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (baseScored.length > 0) return baseScored[0][0];

  return firstMatchByPosition(text, BASE_METAL_WORD_PATTERNS);
}

/* ===========================================================================
 * THE INFERENCE ITSELF
 * ======================================================================== */

/**
 * What metal is this coin, and which rule said so?
 *
 * The four rules are tried strictly in order of how directly they state the
 * answer. The first one that fires wins; if none fires the result is null,
 * which means "leave Metal Content blank and let the user decide".
 *
 *   1. AN EXPLICIT METAL WORD   the caller's `metalHint`, or a precious-metal
 *                               word inside the coin type. Not an inference at
 *                               all — somebody said it out loud.
 *   2. A GOLD-ONLY DENOMINATION $20 / $10 / $5 / $3 / $2.50 in US coinage, and
 *                               the "G$" shorthand. True by Act of Congress.
 *   3. A SERIES NAME            Saint-Gaudens, Double Eagle, Morgan, Peace,
 *                               Mercury-with-a-1916-1945-date, and so on.
 *   4. THE COMPOSITION TEXT     the majority / precious metal it names.
 *
 * Nothing here looks at `category`, `notes` or `grade`. See the file header.
 */
export function inferMetalContentDetailed(evidence: MetalEvidence): MetalInference | null {
  const coinType = String(evidence.coinType ?? '').trim();
  const year = parseLeadingYear(evidence.year);

  /* --- RULE 1a: the caller already read a metal out of the source text --- */
  const hinted = canonicalMetal(evidence.metalHint);
  if (hinted) {
    return {
      metal: hinted,
      rule: 'explicit-metal-hint',
      because: `the source text names the metal as ${hinted}`
    };
  }

  /* --- RULE 1b: a precious-metal word inside the coin TYPE --------------- */
  if (coinType) {
    const typeWord = firstPreciousWord(coinType);
    if (typeWord) {
      return {
        metal: typeWord,
        rule: 'metal-word-in-coin-type',
        because: `the coin type "${coinType}" names ${typeWord}`
      };
    }
  }

  /* --- RULE 2: a denomination that is gold by definition ----------------- */
  const denomination = normaliseDenomination(evidence.denomination);
  if (denomination && isUnitedStatesOrUnknown(evidence.country)) {
    // "G$1", "G$2.50", "G$3" -- the collector's shorthand for the gold issue.
    // This is the one way a "$1" can be settled, and it is settled by the "G",
    // not by the "1".
    if (/^G\$/.test(denomination)) {
      return {
        metal: 'Gold',
        rule: 'gold-shorthand-denomination',
        because: `"${evidence.denomination}" is the collector's "G$" shorthand for the gold issue`
      };
    }

    if (GOLD_ONLY_US_DENOMINATIONS.includes(denomination)) {
      // The one exception: $10 is also the 1/10 oz American Platinum Eagle
      // from 1997, and the bullion era began in 1986. Decline inside it.
      const isAmbiguousModernTen =
        denomination === '$10' && year !== null && year >= BULLION_ERA_FIRST_YEAR;

      if (!isAmbiguousModernTen) {
        return {
          metal: 'Gold',
          rule: 'gold-only-us-denomination',
          because: `the United States never struck a ${evidence.denomination} coin in anything but gold`
        };
      }
    }
  }

  /* --- RULE 3: a series name that implies a metal ------------------------ */
  if (coinType) {
    for (const rule of SERIES_RULES) {
      if (!rule.pattern.test(coinType)) continue;

      // A year-gated rule NEVER fires without a year. That is the point of the
      // gate: "Mercury" alone does not prove silver, "Mercury 1942" does.
      if (rule.years) {
        if (year === null) continue;
        if (year < rule.years.min || year > rule.years.max) continue;
      }

      return {
        metal: rule.metal,
        rule: 'series-name',
        because: rule.because
      };
    }
  }

  /* --- RULE 4: the composition text already on the record ---------------- */
  const fromComposition = metalFromComposition(evidence.composition);
  if (fromComposition) {
    return {
      metal: fromComposition,
      rule: 'composition-text',
      because: `the composition "${evidence.composition}" names ${fromComposition} as its principal metal`
    };
  }

  // Nothing was strong enough. A blank Metal Content is an honest dash.
  return null;
}

/**
 * The same answer with the explanation discarded — the form callers want.
 *
 * @returns One of the canonical `MetalContents` values, or null for "leave it
 *   blank". Never a guess, never a zero, never a value outside the dropdown.
 */
export function inferMetalContent(evidence: MetalEvidence): CoinMetal | null {
  return inferMetalContentDetailed(evidence)?.metal ?? null;
}
