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

/* ---------------------------------------------------------------------------
 * DENOMINATION TABLE
 * ---------------------------------------------------------------------------
 * Ordered MOST SPECIFIC FIRST. The first rule whose pattern appears as a run of
 * consecutive tokens wins.
 *
 * Two hard rules here, both fixing real defects:
 *
 *  1. Patterns are arrays of WHOLE TOKENS, never substrings. This is why a
 *     cert number "2510345" can no longer be read as a quarter ("25") and why
 *     the word "center" can no longer be read as a cent.
 *
 *  2. No pattern is a BARE DIGIT. "25", "10" and "5" on their own mean nothing
 *     in a filename -- they could be a price, a lot number, or part of a date.
 *     Digits only count when paired with a unit ("20 dollar") or written in
 *     the standard collector shorthand ("25c", "10c", "5c").
 *
 * Eagles: Silver Eagle, Gold Eagle, Double Eagle ($20), Half Eagle ($5),
 * Quarter Eagle ($2.50) and the plain Eagle ($10) are FIVE DIFFERENT
 * denominations. The old code collapsed every "eagle" into "dollar". They are
 * separate keys here, and the more specific ones are listed first so they win.
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
  // --- bullion / commemorative eagles (must precede the plain "eagle" rule) ---
  { key: 'silver eagle', label: 'Silver Eagle ($1 bullion)', patterns: [['silver', 'eagle'], ['ase']] },
  { key: 'gold eagle', label: 'Gold Eagle (bullion)', patterns: [['gold', 'eagle']] },
  { key: 'platinum eagle', label: 'Platinum Eagle (bullion)', patterns: [['platinum', 'eagle']] },
  { key: 'palladium eagle', label: 'Palladium Eagle (bullion)', patterns: [['palladium', 'eagle']] },

  // --- classic US gold ---
  { key: 'double eagle', label: 'Double Eagle ($20)', patterns: [['double', 'eagle'], ['twenty', 'dollar'], ['20', 'dollar']] },
  { key: 'half eagle', label: 'Half Eagle ($5)', patterns: [['half', 'eagle'], ['five', 'dollar'], ['5', 'dollar']] },
  { key: 'quarter eagle', label: 'Quarter Eagle ($2.50)', patterns: [['quarter', 'eagle']] },
  { key: 'eagle', label: 'Eagle ($10)', patterns: [['eagle'], ['ten', 'dollar'], ['10', 'dollar']] },

  // --- dollars (specific dollar types before the generic one) ---
  { key: 'trade dollar', label: 'Trade Dollar', patterns: [['trade', 'dollar']] },
  { key: 'half dollar', label: 'Half Dollar (50c)', patterns: [['half', 'dollar'], ['halfdollar'], ['50c'], ['fifty', 'cent']] },

  // --- minor silver / base metal ---
  { key: 'quarter', label: 'Quarter (25c)', patterns: [['quarter', 'dollar'], ['quarter'], ['25c']] },
  { key: 'half dime', label: 'Half Dime', patterns: [['half', 'dime']] },
  { key: 'dime', label: 'Dime (10c)', patterns: [['dime'], ['10c']] },
  { key: 'twenty cent', label: 'Twenty Cent', patterns: [['twenty', 'cent'], ['20c']] },
  { key: 'nickel', label: 'Nickel (5c)', patterns: [['nickel'], ['5c'], ['five', 'cent']] },
  { key: 'three cent', label: 'Three Cent', patterns: [['three', 'cent'], ['3c']] },
  { key: 'two cent', label: 'Two Cent', patterns: [['two', 'cent'], ['2c']] },
  { key: 'half cent', label: 'Half Cent', patterns: [['half', 'cent']] },
  { key: 'large cent', label: 'Large Cent', patterns: [['large', 'cent']] },
  { key: 'cent', label: 'Cent (1c)', patterns: [['cent'], ['penny'], ['1c'], ['one', 'cent']] },

  // --- generic dollar last so "half dollar" / "trade dollar" win first ---
  { key: 'dollar', label: 'Dollar ($1)', patterns: [['dollar'], ['one', 'dollar'], ['1', 'dollar'], ['100c']] }
];

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
  'the', 'and', 'of', 'a', 'an'
]);

/** Camera / phone filename prefixes. A number right after one of these is a
 *  sequence number, NOT a year -- this is what stops "IMG_2024.jpg" from being
 *  read as a 2024 coin. */
export const CAMERA_PREFIXES = new Set([
  'img', 'image', 'dsc', 'dscn', 'dscf', 'dscd', 'pxl', 'p', 'photo', 'pic',
  'scan', 'screenshot', 'mvimg', 'vid', 'gopr', 'pano', 'burst'
]);

/** Third-party grading services. Recognised but not used as coin-type words. */
export const CERT_COMPANIES = new Set(['ngc', 'pcgs', 'anacs', 'icg', 'cac', 'segs', 'cacg']);

/** Grade shorthand, e.g. ms63, au50, pf70, xf45, vf20, pr69dcam. */
export const GRADE_PATTERN = /^(ms|pf|pr|sp|au|xf|ef|vf|vg|ag|fr|po|g|f)-?(\d{1,2})(dcam|cam|ucam|rd|rb|bn|fb|fs|fh|bl)?$/;
