 /*
  * Infers which metal a coin is made of when pm-reference.ts has no catalogued
  * alloy row. `composePmFields` uses this as a coarse fallback, so a coin can
  * get a Metal Content even when its exact weight and purity are unknown.
  *
  *     "1927 $20 Saint-Gaudens"   -> Gold (every US $20 is gold)
  *     "American Gold Eagle"      -> Gold (the type name says so)
  *     "1884 Morgan"              -> Silver (every Morgan is silver)
  *     "1913 France 20 Francs"    -> null (unknown; leave blank)
  *
  * When in doubt, answer nothing: a wrong metal produces a confidently wrong
  * melt value, a blank is visible and fixable. Every rule is true by definition
  * of the series or denomination. Dates struck in two metals (1942 nickel, 1982
  * cent, 1971-78 Eisenhower, a bare "$1" in the gold-dollar era) answer null, as
  * in pm-reference.ts.
  *
  * Never reads `category` (a filing choice, not a property of the coin), nor
  * `notes`, `grade` or `certCompany` ("CAC Gold" is a sticker tier often on
  * silver coins).
  *
  * Every return value is a `CoinMetal`: the list seeded into `MetalContents` by
  * server/setup-database.sql, which feeds the editor's Metal dropdown.
  */

import { CoinMetal } from './pm-reference';

/**
 * Canonical Metal values at run time (`CoinMetal` is compile-time only), in the
 * same order as `INSERT INTO MetalContents` in server/setup-database.sql.
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
 * The metals with a melt value. When a composition names several metals, a
 * precious one wins (see `metalFromComposition`).
 */
const PRECIOUS_METALS: readonly CoinMetal[] = ['Gold', 'Silver', 'Platinum', 'Palladium'];

/** Everything this module reads; nothing else is consulted. */
export interface MetalEvidence {
  /** Type / series, e.g. "Saint-Gaudens", "Gold Eagle", "Morgan". */
  coinType?: string;
  /** Normalised denomination, e.g. "$20", "50¢", "100 Soles". */
  denomination?: string;
  /** Year string; ranges ("1920-1930") and overdates ("1862/1") are tolerated. */
  year?: string;
  /** Country name, e.g. "United States". Gates the US denomination rules. */
  country?: string;
  /** Free-text alloy description already recorded on the coin. */
  composition?: string;
  /**
   * A metal the caller already read from the source: the Quicken importer's
   * `detectMetalHint` (with "CAC Gold" already removed) or the coin's own Metal
   * Content. A direct statement, so it outranks everything.
   */
  metalHint?: string;
}

/** An answer plus the rule that produced it (for tests and debugging). */
export interface MetalInference {
  metal: CoinMetal;
  /** Short, stable identifier for the rule that fired. */
  rule: string;
  /** One readable sentence explaining why. */
  because: string;
}

/**
 * Leading 4-digit year from "1969", "1920-1930" (range) or "1862/1" (overdate).
 * Duplicates a private helper in pm-reference.ts rather than exporting it.
 */
function parseLeadingYear(year: string | undefined): number | null {
  const match = String(year ?? '').match(/^(\d{4})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * A free-text metal word as a canonical `CoinMetal`, or null. Whole values only
 * ("Gold" yes, "goldish" no).
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
 * Normalises a denomination for comparison: upper case, no spaces, no trailing
 * decimal zero ("$2.50" equals "$2.5").
 */
function normaliseDenomination(denomination: string | undefined): string {
  let text = String(denomination ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^G?\$\d+\.\d+$/.test(text)) {
    text = text.replace(/0+$/, '').replace(/\.$/, '');
  }
  return text;
}

/** True for the United States, and for a record with no country. */
function isUnitedStatesOrUnknown(country: string | undefined): boolean {
  const text = String(country ?? '').trim().toLowerCase();
  return text === '' || text === 'united states' || text === 'usa' || text === 'us';
}

 /*
  * Rule 1: an explicit metal word (not an inference).
  *   a) `metalHint`: a metal the caller extracted (Quicken security names such as
  *      "1849-O $1 Gold", "1855 G$1", with "CAC Gold" removed) or the coin's
  *      existing Metal Content. `lookupCoinAlloy` also trusts it.
  *   b) A precious-metal word in the coin type: "Gold Eagle", "Silver Eagle",
  *      "Three Cent Silver".
  * Only precious metals are read from type names: "Nickel" there is a
  * denomination (a 1943 Jefferson Nickel is 35% silver; a Three Cent Nickel is
  * 75% copper).
  */

/** Precious-metal words, in search order. */
const PRECIOUS_WORD_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bgold\b/i, metal: 'Gold' },
  { pattern: /\bsilver\b/i, metal: 'Silver' },
  { pattern: /\bplatinum\b/i, metal: 'Platinum' },
  { pattern: /\bpalladium\b/i, metal: 'Palladium' }
];

/**
 * Removes the "CAC Gold" / "Gold CAC" sticker phrase (a grading tier, not a
 * metal; e.g. "1875 20¢ - PCGS XF40 CAC Gold" is silver). The Quicken importer
 * removes it too, but a coin type is free text.
 */
function scrubCacGoldSticker(text: string): string {
  return text
    .replace(/\bCAC\b\s*[-/]?\s*\bGold\b/gi, 'CAC')
    .replace(/\bGold\b\s*[-/]?\s*\bCAC\b/gi, 'CAC');
}

/**
 * The first precious-metal word by position in the text, or null: "Silver and
 * Gold commemorative" answers Silver (majority-first convention).
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

 /*
  * Rule 2: US face values only ever struck in gold.
  *     $20   Double Eagle, 1849-1933; the only US $20, always 0.900 gold
  *     $10   Eagle, 1795-1933, and the 1/4 oz Gold Eagle from 1986 (see below)
  *     $5    Half Eagle, the 1/10 oz Gold Eagle, and all modern $5 commemoratives
  *     $3    Three Dollar piece, 1854-1889
  *     $2.50 Quarter Eagle, 1796-1929
  *
  * "$1" is excluded: from 1849 to 1889 both silver and gold dollars were struck
  * (and later clad and manganese-brass dollars). A leading "G" ("G$1", "G$2.50")
  * is collector shorthand for the gold issue and is accepted.
  *
  * $10 from 1986 is also the 1/10 oz Platinum Eagle (1997 on), so the $10 rule
  * is off from 1986 unless a type name has settled it. A $10 with no year is
  * read as gold (classic Eagles vastly outnumber platinum). $25 and $50 are
  * excluded: $50 is the Gold Eagle, Gold Buffalo, Platinum Eagle and the 1915
  * Panama-Pacific commemorative.
  */

/** Normalised US denominations only ever struck in gold. */
const GOLD_ONLY_US_DENOMINATIONS: readonly string[] = ['$20', '$10', '$5', '$3', '$2.5'];

/** First year of the modern bullion programmes, which reused old face values. */
const BULLION_ERA_FIRST_YEAR = 1986;

 /*
  * Rule 3: series names that imply a metal ("Saint-Gaudens" is always a gold
  * $20, "Morgan" always a silver dollar).
  *
  * Silver entries carry year bands: the Coinage Act of 1965 removed silver from
  * the dime and quarter, and some designs were revived in gold in 2016 (Mercury
  * dime, Standing Liberty quarter, Walking Liberty half). A banded rule never
  * fires without a year. Gold names were never reused, so need no band.
  *
  * Deliberately excluded because they name coins in more than one metal:
  *     Liberty Head   5¢ (cupronickel), $20 (gold), Type 1 gold dollar
  *                    ("Double Eagle" below covers the safe case)
  *     Indian Head    1¢ (bronze), $2.50/$5/$10 (gold), sometimes the 5¢ Buffalo
  *     Classic Head   copper half cents/cents and gold $2.50/$5
  *     Draped Bust    copper cents, silver dimes-dollars, gold $2.50-$10
  *     Capped Bust    silver 10¢-50¢ and gold $2.50/$5
  *     Flowing Hair   silver half dimes-dollars and copper cents/half cents
  *     Coronet        gold $2.50-$20 and the Coronet Head large cent
  *     Jefferson      1942-45 war nickels are 35% silver; 1942 struck both ways
  *     Eisenhower     1971-78 business strikes clad, collector issues 40% silver
  *     Lincoln        1982 struck in bronze and copper-plated zinc
  * Denomination plus year settles these where possible, in `lookupCoinAlloy`.
  */

interface SeriesRule {
  /** Matched against the coin type (whole words, case-insensitive). */
  pattern: RegExp;
  metal: CoinMetal;
  /**
   * When present, the rule fires only for a year inside this band, never for a
   * record with no year.
   */
  years?: { min: number; max: number };
  /** Why this is safe; shown in `MetalInference.because`. */
  because: string;
}

const SERIES_RULES: readonly SeriesRule[] = [
  /* Gold: names never used on a coin of another metal */
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
    // The Type 2/3 gold dollar and $3 gold piece; never used on other metals.
    pattern: /\bindian\s+princess\b/i,
    metal: 'Gold',
    because: 'the Indian Princess design belongs to the gold dollar and the $3 gold piece'
  },
  {
    // Also caught by the metal-word rule; listed so the series list is complete.
    pattern: /\bgold\s+(?:eagle|dollar|buffalo)\b/i,
    metal: 'Gold',
    because: 'the series name says gold'
  },

  /* Silver: silver in every year the series ran */
  {
    // 1878-1904 and 1921 at 90%; 2021 onward at 99.9%.
    pattern: /\bmorgan\b/i,
    metal: 'Silver',
    because: 'every Morgan dollar ever struck is silver'
  },
  {
    // 1921-1935 at 90%; 2021 onward at 99.9%.
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

  /* Silver, year-gated: later revived in gold or the denomination went clad */
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
    // The 1965 cutoff: a 1965 Washington quarter is clad.
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
    // The Kennedy half kept 40% silver through 1970.
    pattern: /\bkennedy\b/i,
    metal: 'Silver',
    years: { min: 1964, max: 1970 },
    because: 'Kennedy halves are 90% silver in 1964 and 40% silver 1965-1970; 1971 onward are clad'
  }
];

 /*
  * Rule 4: the composition text (weakest; often hand-typed). Compositions name
  * several metals, majority first:
  *     "90% Gold, 10% Copper"                    double eagle
  *     "91.67% Gold, 8.33% Silver and Copper"    early US gold
  *     "92.5% Silver, 7.5% Copper (sterling)"    British crown
  * so a "contains Copper?" test would be wrong. Steps, in order:
  *   1. "X-plated Y" / "X-coated Y": the metal is the core Y ("Copper-plated
  *      zinc" is a zinc cent; "Zinc-coated steel" is the 1943 steel cent).
  *   2. A precious metal anywhere wins over base metals; with several, the
  *      larger percentage wins. (The 1943-45 war nickel, "56% Copper, 35%
  *      Silver, 9% Manganese", is Silver, as in pm-reference.ts.)
  *   3. A named alloy wins over its ingredients ("Copper-Nickel clad",
  *      "Manganese brass" -> Brass).
  *   4. The base metal with the largest stated percentage, else the first named.
  */

/** Compound alloy names, checked before their ingredients. */
const ALLOY_NAME_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bcupro[-\s]?nickel\b|\bcopper[-\s]nickel\b/i, metal: 'Copper-Nickel' },
  { pattern: /\bnickel[-\s]brass\b/i, metal: 'Nickel-Brass' },
  { pattern: /\bbronze\b/i, metal: 'Bronze' },
  { pattern: /\bbrass\b/i, metal: 'Brass' }
];

/** Bare metal words, most specific first. */
const BASE_METAL_WORD_PATTERNS: readonly { pattern: RegExp; metal: CoinMetal }[] = [
  { pattern: /\bcopper\b/i, metal: 'Copper' },
  { pattern: /\bnickel\b/i, metal: 'Nickel' },
  { pattern: /\bzinc\b/i, metal: 'Zinc' },
  { pattern: /\bsteel\b/i, metal: 'Steel' },
  { pattern: /\balumini?um\b/i, metal: 'Aluminum' },
  { pattern: /\bclad\b/i, metal: 'Clad' }
];

/**
 * Reads "<number>% <metal>" pairs and returns the largest percentage per metal.
 * Only the word right after the percentage counts: "91.67% Gold, 8.33% Silver
 * and Copper" scores Gold 91.67, Silver 8.33, Copper unscored.
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

/** The metal a composition describes, or null (steps described above). */
export function metalFromComposition(composition: string | undefined): CoinMetal | null {
  const text = scrubCacGoldSticker(String(composition ?? '').trim());
  if (!text) return null;

  // Step 1: plating/coating is the skin; the second metal is the coin.
  const plated = text.match(/\b[A-Za-z]+[-\s](?:plated|coated)\s+([A-Za-z]+)\b/i);
  if (plated) {
    const core = canonicalMetal(plated[1]);
    if (core) return core;
  }

  const scores = percentagesByMetal(text);

  // Step 2: a precious metal outranks base metals; larger percentage wins.
  const preciousScored = PRECIOUS_METALS
    .filter((metal) => scores.has(metal))
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0));
  if (preciousScored.length > 0) return preciousScored[0];

  // ...a precious metal named without a percentage ("sterling silver") still wins.
  const preciousWord = firstPreciousWord(text);
  if (preciousWord) return preciousWord;

  // Step 3: a named alloy outranks its ingredients.
  const alloyName = firstMatchByPosition(text, ALLOY_NAME_PATTERNS);
  if (alloyName) return alloyName;

  // Step 4: largest stated base-metal percentage, else the first named.
  const baseScored = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (baseScored.length > 0) return baseScored[0][0];

  return firstMatchByPosition(text, BASE_METAL_WORD_PATTERNS);
}

/**
 * Which metal a coin is, and which rule said so. Rules are tried in order;
 * the first that fires wins, and null means leave Metal Content blank:
 *   1. explicit metal word    `metalHint`, or a precious-metal word in the type
 *   2. gold-only denomination US $20 / $10 / $5 / $3 / $2.50, and "G$" shorthand
 *   3. series name            Saint-Gaudens, Double Eagle, Morgan, Peace,
 *                             Mercury dated 1916-1945, ...
 *   4. composition text       the precious or majority metal it names
 */
export function inferMetalContentDetailed(evidence: MetalEvidence): MetalInference | null {
  const coinType = String(evidence.coinType ?? '').trim();
  const year = parseLeadingYear(evidence.year);

  /* Rule 1a: the caller's metal hint */
  const hinted = canonicalMetal(evidence.metalHint);
  if (hinted) {
    return {
      metal: hinted,
      rule: 'explicit-metal-hint',
      because: `the source text names the metal as ${hinted}`
    };
  }

  /* Rule 1b: a precious-metal word in the coin type */
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

  /* Rule 2: a denomination that is gold by definition */
  const denomination = normaliseDenomination(evidence.denomination);
  if (denomination && isUnitedStatesOrUnknown(evidence.country)) {
    // "G$" shorthand: the "G" settles it, which is the only way a "$1" can be settled.
    if (/^G\$/.test(denomination)) {
      return {
        metal: 'Gold',
        rule: 'gold-shorthand-denomination',
        because: `"${evidence.denomination}" is the collector's "G$" shorthand for the gold issue`
      };
    }

    if (GOLD_ONLY_US_DENOMINATIONS.includes(denomination)) {
      // $10 is also the Platinum Eagle in the bullion era; decline from 1986.
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

  /* Rule 3: a series name that implies a metal */
  if (coinType) {
    for (const rule of SERIES_RULES) {
      if (!rule.pattern.test(coinType)) continue;

      // A year-gated rule never fires without a year.
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

  /* Rule 4: the composition text */
  const fromComposition = metalFromComposition(evidence.composition);
  if (fromComposition) {
    return {
      metal: fromComposition,
      rule: 'composition-text',
      because: `the composition "${evidence.composition}" names ${fromComposition} as its principal metal`
    };
  }

  // Nothing was strong enough: leave it blank.
  return null;
}

/**
 * The inferred metal without the explanation.
 *
 * @returns a canonical `MetalContents` value, or null to leave it blank
 */
export function inferMetalContent(evidence: MetalEvidence): CoinMetal | null {
  return inferMetalContentDetailed(evidence)?.metal ?? null;
}
