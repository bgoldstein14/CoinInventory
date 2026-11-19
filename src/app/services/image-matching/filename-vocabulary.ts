 /*
 * Words that appear in filenames but describe something other than which coin
 * it is: side words, photo qualifiers, grade vocabulary, non-coin words and
 * ancient catalogue prefixes. Pure data with no imports, so it can never be
 * part of an import cycle.
 *
 * Tokens arrive already singularized ("coins" -> "coin"), so token lists are
 * singular; the group-shot detector reads the raw filename to see plurals.
  */

 /*
 * Side words: stripped before scoring, but reported so the import UI can
 * group obverse and reverse shots under one coin.
  */

/** Canonical sides we can report. "Label" is the slab's certification label. */
export type ParsedSide = 'obverse' | 'reverse' | 'label';

/** Spelling variants -> canonical side. Longest forms listed first. */
export const SIDE_WORDS: ReadonlyArray<{ word: string; side: ParsedSide }> = [
  { word: 'obverse', side: 'obverse' },
  { word: 'reverse', side: 'reverse' },
  { word: 'obv', side: 'obverse' },
  { word: 'rev', side: 'reverse' },
  { word: 'label', side: 'label' },
  { word: 'slab', side: 'label' }
];

 /*
 * Photo qualifiers: how the photo was produced or sized; never scored.
 * `small` / `large` are safe despite "Large Cent" because denominations are
 * detected before stop words are removed.
  */
export const PHOTO_VARIANT_WORDS: readonly string[] = [
  'photo', 'orig', 'original', 'sharpened', 'sharp', 'small', 'large',
  'cropped', 'crop', 'closeup', 'resized', 'thumb', 'thumbnail'
];

 /*
 * Grade vocabulary, split by how the words combine:
 *   base         the grade itself            ("VF", "MS", "PF")
 *   modifier     adjectives in front of it   ("Choice VF", "Gem BU")
 *   designation  suffixes after a number     ("PF64Cameo", "PF69 DCAM")
  */

/**
 * Multi-letter grade abbreviations, safe to recognise on their own. Single
 * letters F and G are handled more narrowly in grade-parser.ts, since a lone
 * letter is usually an initial or typo.
 */
export const GRADE_BASE_WORDS: readonly string[] = [
  'ms', 'pf', 'pr', 'sp', 'au', 'xf', 'ef', 'vf', 'vg', 'ag', 'fr', 'po',
  'unc', 'bu', 'gem'
];

/** Adjectives that qualify a grade. "Choice VF", "Gem BU", "About Uncirculated". */
export const GRADE_MODIFIER_WORDS: readonly string[] = [
  'choice', 'gem', 'select', 'about', 'near', 'nearly', 'superb', 'uncirculated'
];

/**
 * Strike / colour designations that follow a numeric grade.
 * Ordered longest first so "cameo" is never matched as "cam" + leftover "eo".
 */
export const GRADE_DESIGNATION_WORDS: readonly string[] = [
  'dcameo', 'cameo', 'dcam', 'ucam', 'cam', 'dpl', 'pl',
  'rd', 'rb', 'bn', 'fb', 'fs', 'fh', 'bl', 'star'
];

/**
 * All grade words as one list for STOP_WORDS, so a stray "Choice" never
 * counts as coin-type evidence.
 */
export const GRADE_NOISE_WORDS: readonly string[] = [
  ...GRADE_BASE_WORDS,
  ...GRADE_MODIFIER_WORDS,
  ...GRADE_DESIGNATION_WORDS
];

 /*
 * Non-coin and group-shot words: a filename containing any of these is not a
 * photo of one identifiable coin. Applied in non-coin-detector.ts.
  */

/** Items that are not coins at all. A stamp must never match a three-cent coin. */
export const NON_COIN_ITEM_WORDS: readonly string[] = [
  'stamp', 'stamps', 'paper', 'fractional', 'bond', 'bonds', 'coupon',
  'coupons', 'note', 'notes', 'currency', 'banknote', 'scrip', 'certificate',
  'envelope', 'cover', 'book', 'books'
];

/** Words that mean "several coins" or "the container they live in". */
export const GROUP_SHOT_WORDS: readonly string[] = [
  'set', 'sets', 'album', 'albums', 'box', 'boxes', 'part', 'group',
  'collection', 'lot', 'page', 'pages', 'tray', 'folder', 'roll', 'rolls',
  'assortment', 'misc', 'miscellaneous', 'various'
];

/**
 * Plural denominations ("Gold Coins", "Canadian Cents") mark group shots.
 * Matched on the raw filename, since tokens are already singular. A single
 * coin named "Canada 5 Cents" would be misread; the collection uses the
 * singular form ("50-Cent"), and the miss only sends the file to review.
 */
export const PLURAL_DENOMINATION_WORDS: readonly string[] = [
  'coins', 'cents', 'dimes', 'dollars', 'quarters', 'nickels', 'eagles',
  'pennies', 'halves', 'denarii', 'shekels', 'sovereigns', 'crowns'
];

/*
 * Catalogue prefixes for ancients, which are identified by reference
 * ("Sear 6819", "RIC 34") rather than year and mint mark. "Price" is omitted:
 * it collides with the English word ("lot 10 price 5.00" -> "price5").
 */
export const CATALOG_PREFIXES: readonly string[] = [
  'sear', 'ric', 'hendin', 'rpc', 'svoronos', 'bmc', 'sng', 'crawford',
  'sydenham', 'cohen', 'rsc', 'meshorer', 'tjc', 'kraay'
];

/** Era markers. Captured as part of the era date, never as coin-type words. */
export const ERA_WORDS: readonly string[] = ['bc', 'bce', 'ad', 'ce'];

/*
 * Folded into STOP_WORDS by reference-tables.ts. Group / non-coin words are
 * excluded so the detector can still see them.
 */
export const PHOTO_NOISE_WORDS: readonly string[] = [
  ...SIDE_WORDS.map(entry => entry.word),
  ...PHOTO_VARIANT_WORDS,
  ...GRADE_NOISE_WORDS,
  ...ERA_WORDS
];

 /*
 * Markers that affect only the automated decision; any file can still be
 * attached by hand.
  */

/**
 * Words marking a counterfeit ("FAKE - 1860 3CS - VF - Obverse.jpg"); they
 * feed the authenticity veto in match-vetoes.ts. "copy" is omitted: Windows
 * appends it to duplicated files.
 */
export const COUNTERFEIT_MARKER_WORDS: readonly string[] = [
  'fake', 'counterfeit', 'replica'
];

/**
 * Words marking a photo of several coins ("20¢ Collage.jpg",
 * "1875 and 1876 3CN mini-hoard - Obverse.jpg"). Applied by
 * `detectAutoImportExclusion`: unlike `isNonCoin`, such a photo is also left
 * out of tier 3's "Attach anyway..." list.
 *
 * Not markers: "set" (many records are proof sets, so "set" photos may belong
 * to them), "close-up" (still a photo of the coin) and "cleaned" (a condition
 * descriptor, e.g. "AU58 Cleaned").
 */
export const MULTI_COIN_MARKER_WORDS: readonly string[] = [
  'collage', 'montage', 'hoard', 'group'
];
