 /*
 * The matcher's coin dictionaries: denomination table and equivalences, US
 * mint marks, and token filters (stop words, camera prefixes, grading
 * services, grade shorthand). Pure data; new vocabulary belongs here.
  */

import { PHOTO_NOISE_WORDS } from './filename-vocabulary';

 /*
 * Denomination table, ordered most specific first: the first rule whose
 * pattern appears as a run of consecutive tokens wins.
 *
 *  1. Patterns are whole tokens, never substrings ("center" is not "cent",
 *     cert number "2599001" is not a quarter).
 *  2. No bare-digit patterns: ['20','dollar'] and ['3cn'] are fine, ['20'] is
 *     not. Sign/hyphen forms ("$20", "20-cent") are read in denomination-units.ts.
 *
 * Eagles are five denominations: Silver Eagle ($1), Quarter ($2.50), Half
 * ($5), Eagle ($10), Double ($20). The bare word "Eagle" parses to the vague
 * 'gold eagle' and is resolved by `resolveEagleSeries`.
 *
 * Aliases mostly share a key ("Double Eagle"/"$20"); see DENOMINATION_EQUIVALENCES.
  */
export interface DenominationRule {
  /** Canonical key -- two denominations agree only if their keys are equal. */
  key: string;
  /** Friendly label for the UI. */
  label: string;
  /** Each entry is a sequence of consecutive tokens that identifies this rule. */
  patterns: string[][];
}

export const DENOMINATION_RULES: readonly DenominationRule[] = [
  /* --- non-gold eagles: must precede every rule containing ['eagle'].
   * A Silver Eagle is $1. */
  { key: 'silver eagle', label: 'Silver Eagle ($1 bullion)', patterns: [['silver', 'eagle'], ['ase']] },
  { key: 'platinum eagle', label: 'Platinum Eagle (bullion)', patterns: [['platinum', 'eagle']] },
  { key: 'palladium eagle', label: 'Palladium Eagle (bullion)', patterns: [['palladium', 'eagle']] },

  /* --- $25 and $50: modern bullion face values (1986-) ---
   * ['twenty','five','dollar'] must precede the Half Eagle's ['five','dollar'],
   * which it contains. The "$25" / "$50" sign forms are read by
   * denomination-units.ts. */
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

  // --- classic US gold: named multiples of the Eagle (unambiguous) ---
  { key: 'double eagle', label: 'Double Eagle ($20)', patterns: [['double', 'eagle'], ['twenty', 'dollar'], ['20', 'dollar']] },
  { key: 'half eagle', label: 'Half Eagle ($5)', patterns: [['half', 'eagle'], ['five', 'dollar'], ['5', 'dollar']] },
  { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)', patterns: [['quarter', 'eagle']] },

  /* The bare word "Eagle": could be the classic $10 or a modern bullion size.
   * `resolveEagleSeries` resolves it by year; undated, it vetoes nothing.
   * Must sit below double / half / quarter eagle, which contain ['eagle']. */
  {
    key: 'gold eagle',
    label: 'Eagle (series undetermined)',
    patterns: [['gold', 'eagle'], ['eagle']]
  },

  /* --- dollars (specific types before the generic one) ---
   * Trade, gold and silver dollars are distinct coins; a bare "$1" is the
   * generic 'dollar' at the bottom of the table. "G$1" is read by
   * denomination-units.ts because tokenizing removes the "$". */
  { key: 'trade dollar', label: 'Trade Dollar', patterns: [['trade', 'dollar']] },
  { key: 'gold dollar', label: 'Gold Dollar (G$1)', patterns: [['gold', 'dollar']] },
  { key: 'silver dollar', label: 'Silver Dollar', patterns: [['silver', 'dollar']] },
  { key: 'three dollar', label: 'Three Dollar ($3)', patterns: [['three', 'dollar'], ['3', 'dollar']] },
  { key: 'half dollar', label: 'Half Dollar (50c)', patterns: [['half', 'dollar'], ['halfdollar'], ['50c'], ['fifty', 'cent']] },

  // --- minor silver / base metal ---
  { key: 'quarter', label: 'Quarter (25c)', patterns: [['quarter', 'dollar'], ['quarter'], ['25c']] },
  // Half dime: silver five-cent piece (1792-1873), distinct from the nickel.
  { key: 'half dime', label: 'Half Dime', patterns: [['half', 'dime']] },
  { key: 'dime', label: 'Dime (10c)', patterns: [['dime'], ['10c']] },
  { key: 'twenty cent', label: 'Twenty Cent', patterns: [['twenty', 'cent'], ['20c']] },

  /*
   * Three cent: "3CN" / "3CS" survive tokenizing as single tokens. 3CS (silver
   * trime) and 3CN (copper-nickel) are different coins under the generic
   * 'three cent'. Must sit above 'nickel', or "Three Cent Nickel" would be read
   * as a five-cent piece. Digit spellings are listed only with a metal word;
   * a bare "3-cent" is handled by denomination-units.ts.
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

  // Five cents: generic 'five cent' over Half Dime (silver, 1792-1873) and
  // Nickel (1866-). 'nickel' must come after the three-cent rules.
  { key: 'five cent', label: 'Five Cent (5c)', patterns: [['5c'], ['five', 'cent']] },
  { key: 'nickel', label: 'Nickel (5c)', patterns: [['nickel']] },

  { key: 'two cent', label: 'Two Cent', patterns: [['two', 'cent'], ['2c']] },
  { key: 'half cent', label: 'Half Cent', patterns: [['half', 'cent']] },

  // One cent: generic 'cent' over Large Cent (1793-1857) and Small Cent (1856-).
  { key: 'large cent', label: 'Large Cent', patterns: [['large', 'cent']] },
  { key: 'small cent', label: 'Small Cent', patterns: [['small', 'cent']] },
  { key: 'cent', label: 'Cent (1c)', patterns: [['cent'], ['penny'], ['1c'], ['one', 'cent']] },

  // Generic dollar last so specific dollar types win.
  { key: 'dollar', label: 'Dollar ($1)', patterns: [['dollar'], ['one', 'dollar'], ['1', 'dollar'], ['100c']] }
];

 /*
 * Denomination equivalences: when two different keys can still mean one coin.
 *
 *  A. Alias: two names for one face value, interchangeable (Silver Eagle == $1).
 *     Most aliases share a key in DENOMINATION_RULES and need no row here.
 *
 *  B. Generic over specifics: the generic agrees with every specific; the
 *     specifics conflict with each other.
 *         3c  over  3CS / 3CN
 *         1c  over  Large Cent / Small Cent
 *         5c  over  Half Dime / Nickel
 *         $1  over  Gold Dollar / Silver Dollar / Trade Dollar
 *     Records and filenames often state only the face value, so the generic
 *     must not veto a specific. The specifics overlap in date, so the year
 *     can't separate them.
 *
 * Silver Eagle is a $1 bullion coin, not the $10 gold Eagle;
 * `denominationsAgree('silver eagle', 'eagle')` is false.
 *
 * Not transitive: Silver Eagle == $1 and $1 ~ Trade Dollar does not make a
 * Silver Eagle match a Trade Dollar.
 *
 * When adding a row: a wrong equivalence silently attaches photos to the wrong
 * coin, while a missing one only sends a pair to review. Add a generic group
 * only when the generic can mean nothing but the listed specifics.
  */

/** Two names for one face value, fully interchangeable. */
export interface DenominationAlias {
  kind: 'alias';
  /** Interchangeable keys. Order is irrelevant. */
  names: readonly string[];
  /** Plain English, for the reader rather than the code. */
  why: string;
}

/**
 * One vague key over the coins it might be. `generic` agrees with every
 * entry in `specific`; the specifics never agree with each other.
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

/** The shared equivalence table, consulted only through `denominationsAgree`. */
export const DENOMINATION_EQUIVALENCES: readonly DenominationEquivalence[] = [
  /* --- A. aliases. Most aliases already share a key in the parse tables. --- */
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

  /* --- B. generic over specifics: the generic matches any; specifics conflict --- */
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
    /* The undated Eagle: 'gold eagle' with no usable year. Specifics are every
     * face value an Eagle can carry ($10 classic; $5/$10/$25/$50 bullion).
     * $20 and $2.50 have their own names and are excluded. */
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
 * Do these two denomination keys describe the same coin? Use this wherever
 * denominations are compared; `===` would reject the pairs above.
 * Not transitive: rows are never chained. A missing value is not agreement.
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
 * True when the two keys agree via the equivalence table rather than being
 * identical. Used to word explanations ("Three Cent is the general form of
 * Three Cent Silver").
 */
export function denominationsAgreeLoosely(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  return denominationsAgree(left, right) && left !== right;
}

/**
 * True when `specific` is one of the coins `generic` stands over
 * ('three cent silver' under 'three cent'). filename-parser.ts uses this to
 * keep the word table's sharper answer over a face value, e.g.
 * "1864 3-cent silver" should be 3CS, not the vague 'three cent'.
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

 /*
 * Which Eagle? Resolved by year:
 *   Classic gold Eagle    $10, 1795-1933
 *   American Gold Eagle   bullion, 1986-: 1/10 oz $5, 1/4 oz $10, 1/2 oz $25, 1 oz $50
 *   1934-1985             no gold Eagle struck
 *
 * The gap is what makes year resolution safe here. Don't apply it to the
 * other generic groups (Half Dime/Nickel, 3CS/3CN, Large/Small Cent), whose
 * dates overlap. Without a year the vague key is left unresolved.
  */

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

 /*
 * Weight words that name a modern Gold Eagle's size. Consulted only once the
 * year says "modern". Ordered most specific first ("1 oz" last so it can't
 * claim "1/10 oz").
 *
 * Fractions accept "/", "-", "_" and the single glyph: a filename can't
 * contain "/", but coin record text can.
 *
 * Fractional sizes share the classic keys (1/10 oz = $5 'half eagle',
 * 1/4 oz = $10 'eagle'); the year veto keeps them apart from classic records.
  */
const GOLD_EAGLE_SIZES: ReadonlyArray<{ pattern: RegExp; key: string; label: string }> = [
  { pattern: /(?:1\s*[/\-_]\s*10|⅒)\s*(?:oz|ounce)/i, key: 'half eagle', label: 'Gold Eagle 1/10 oz ($5)' },
  { pattern: /(?:1\s*[/\-_]\s*4|¼)\s*(?:oz|ounce)/i, key: 'eagle', label: 'Gold Eagle 1/4 oz ($10)' },
  { pattern: /(?:1\s*[/\-_]\s*2|½)\s*(?:oz|ounce)/i, key: 'twenty five dollar', label: 'Gold Eagle 1/2 oz ($25)' },
  { pattern: /(?:^|[^0-9/\-_])1\s*(?:oz|ounce)/i, key: 'fifty dollar', label: 'Gold Eagle 1 oz ($50)' }
];

/**
 * Turn the vague 'gold eagle' key into a real face value using the year. Used
 * by both the filename and coin-record parsers. A no-op for every other key.
 *
 * @param denomination what the word/sign tables produced (may be null)
 * @param year         the year the same parser read, or null if it read none
 * @param text         the raw text, searched for a weight word as a refinement
 *
 * Outcomes:
 *   no year       -> unchanged (the vague key vetoes nothing)
 *   year <= 1933  -> classic $10 Eagle
 *   year >= 1986  -> modern bullion: the size named by a weight word, else $50 (1 oz)
 *   1934 .. 1985  -> unchanged (no gold Eagle has such a date)
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

/** Friendly label for a mint code; unknown codes fall back to the code in upper case. */
export function mintLabel(code: string): string {
  return MINT_LABELS[code] ?? code.toUpperCase();
}

/** Words that say nothing about which coin this is; removed before comparing coin-type words. */
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

  // Photo, side and grade vocabulary, so every caller of `meaningfulTokens`
  // drops them identically. Denomination detection runs before stop-word
  // removal, so "Large Cent" / "Small Cent" still work.
  ...PHOTO_NOISE_WORDS
]);

/** Camera / phone filename prefixes. A number right after one is a sequence
 *  number, not a year ("IMG_2024.jpg" is not a 2024 coin). "coin" is omitted
 *  because it can legitimately precede a year ("Coin 1881 Morgan"). */
export const CAMERA_PREFIXES = new Set([
  'img', 'image', 'im', 'dsc', 'dscn', 'dscf', 'dscd', 'pxl', 'p',
  'photo', 'pic', 'pict', 'scan', 'screenshot', 'mvimg', 'vid', 'gopr',
  'pano', 'burst'
]);

/**
 * Third-party grading services. Weak evidence alone (many coins are "PCGS");
 * strong when paired with a matching grade (see match-scorer.ts).
 */
export const CERT_COMPANIES = new Set([
  'ngc', 'pcgs', 'anacs', 'icg', 'cac', 'cacg', 'segs', 'nnc'
]);

/**
 * Grade shorthand as a whole token, e.g. ms63, pf65rb, pr69dcam. Keeps grades
 * out of the coin-type evidence; richer forms ("VF+", "Choice VF") are read
 * by grade-parser.ts. Designations are ordered longest first ("cameo" before "cam").
 */
export const GRADE_PATTERN =
  /^(ms|pf|pr|sp|au|xf|ef|vf|vg|ag|fr|po|g|f)-?(\d{1,2})(dcameo|cameo|dcam|ucam|cam|dpl|pl|rd|rb|bn|fb|fs|fh|bl|star)?$/;
