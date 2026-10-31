/* ===========================================================================
 * filename-vocabulary.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   The words that appear in THIS COLLECTION'S filenames but describe
 *   something OTHER than which coin it is:
 *     - side words        (Obverse / Reverse / Label)
 *     - photo qualifiers  (Photo / Orig / Sharpened / Small / Large)
 *     - grade vocabulary  (VF / MS / Choice / DCAM / ...)
 *     - non-coin words    (Stamp / Bond / Set / Album / ...)
 *     - catalogue prefixes for ancients (Sear / RIC / Hendin / ...)
 *
 * WHY IT IS ITS OWN FILE
 *   reference-tables.ts is the dictionary of COIN knowledge ("what words mean
 *   which face value"). This file is the opposite: a dictionary of NOISE. The
 *   two grow for different reasons, and splitting them keeps each file short
 *   enough to read in one sitting.
 *
 *   It is pure data with ZERO imports, on purpose. Several modules need these
 *   lists (reference-tables folds them into STOP_WORDS, and the three parser
 *   modules each read their own slice), so having no dependencies of its own
 *   guarantees it can never take part in an import cycle.
 *
 *   NOTE ON PLURALS: `text-tokens.singularize` chops a trailing "s" off words
 *   longer than three characters, so a token arrives here already singular
 *   ("coins" -> "coin", "boxes" -> "boxe"). Lists meant for TOKEN lookup are
 *   therefore written in singular form, while the group-shot detector works on
 *   the RAW filename precisely so it can still see the plural.
 * =========================================================================== */

/* ---------------------------------------------------------------------------
 * SIDE WORDS -- which face of the coin the photo shows
 * ---------------------------------------------------------------------------
 * These describe the PHOTO, not the coin, so they are stripped before scoring
 * (they are folded into STOP_WORDS) -- but we also report which side we saw,
 * because the import UI groups an Obverse and a Reverse shot under one coin.
 * ------------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------------
 * PHOTO QUALIFIERS -- how the photo was produced or sized
 * ---------------------------------------------------------------------------
 * "1904 $20 - PCGS MS63 - small.jpg" is the SAME coin as the un-suffixed
 * version, just a smaller file. These words must never contribute to (or
 * dilute) a score.
 *
 * `small` / `large` are here even though "Large Cent" and "Small Cent" are real
 * denominations. That is safe because denomination detection runs on the raw
 * token list BEFORE stop words are removed, so the ['large','cent'] rule still
 * fires; only the leftover coin-type words are filtered.
 * ------------------------------------------------------------------------- */
export const PHOTO_VARIANT_WORDS: readonly string[] = [
  'photo', 'orig', 'original', 'sharpened', 'sharp', 'small', 'large',
  'cropped', 'crop', 'closeup', 'resized', 'thumb', 'thumbnail'
];

/* ---------------------------------------------------------------------------
 * GRADE VOCABULARY
 * ---------------------------------------------------------------------------
 * Split into three lists because they combine differently:
 *   BASE       -- the grade itself            ("VF", "MS", "PF")
 *   MODIFIER   -- adjectives in front of it   ("Choice VF", "Gem BU")
 *   DESIGNATION-- suffixes after a number     ("PF64Cameo", "PF69 DCAM")
 * ------------------------------------------------------------------------- */

/**
 * Multi-letter grade abbreviations. These are safe to recognise on their own
 * ("1812 50c VG - Obverse" really is a VG coin).
 *
 * The single letters F (Fine) and G (Good) are DELIBERATELY absent: a lone "F"
 * or "G" in a filename is far more likely to be an initial, a drive letter or
 * a typo. They are only accepted with a modifier in front ("Choice F") or as a
 * segment of their own, and grade-parser.ts owns that narrower rule.
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
 * Ordered LONGEST FIRST so "cameo" is never matched as "cam" + leftover "eo".
 */
export const GRADE_DESIGNATION_WORDS: readonly string[] = [
  'dcameo', 'cameo', 'dcam', 'ucam', 'cam', 'dpl', 'pl',
  'rd', 'rb', 'bn', 'fb', 'fs', 'fh', 'bl', 'star'
];

/**
 * Everything above, as one flat list for STOP_WORDS. Any stray grade word that
 * the structured grade parser did not consume still must not survive as
 * "coin type" evidence -- otherwise two unrelated coins could look similar
 * merely because both filenames say "Choice".
 */
export const GRADE_NOISE_WORDS: readonly string[] = [
  ...GRADE_BASE_WORDS,
  ...GRADE_MODIFIER_WORDS,
  ...GRADE_DESIGNATION_WORDS
];

/* ---------------------------------------------------------------------------
 * NON-COIN AND GROUP-SHOT WORDS
 * ---------------------------------------------------------------------------
 * A filename containing any of these is NOT a photo of one identifiable coin,
 * so it must never be auto-assigned. See non-coin-detector.ts for how these
 * are applied (and why the check runs on the raw filename, not on tokens).
 * ------------------------------------------------------------------------- */

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
 * Plural denominations. "Gold Coins", "Canadian Cents", "Half Dimes and Cap
 * and Rays" are all group shots. This is matched on the RAW filename because
 * tokenizing would have already made them singular.
 *
 * Known limitation: a legitimate single coin written as "Canada 5 Cents" would
 * be treated as a group shot. This collection consistently uses the singular
 * hyphenated form ("50-Cent", "20-cent"), so the trade-off is worth it -- and
 * erring towards "ask the user" is the matcher's whole philosophy.
 */
export const PLURAL_DENOMINATION_WORDS: readonly string[] = [
  'coins', 'cents', 'dimes', 'dollars', 'quarters', 'nickels', 'eagles',
  'pennies', 'halves', 'denarii', 'shekels', 'sovereigns', 'crowns'
];

/* ---------------------------------------------------------------------------
 * ANCIENT / WORLD CATALOGUE PREFIXES
 * ---------------------------------------------------------------------------
 * Ancients have no year-and-mintmark. They are identified by a reference into
 * a standard catalogue: "Sear 6819", "RIC 34", "Hendin 736".
 * ------------------------------------------------------------------------- */
/*
 * DELIBERATELY ABSENT: "Price" (the standard catalogue for Alexander
 * tetradrachms). It collides with the ordinary English word -- the filename
 * "1916 lot 10 price 5.00 cert 25999.jpg" would yield the catalogue reference
 * "price5". A real Price citation is rare enough that losing it costs far less
 * than a false identifier would.
 */
export const CATALOG_PREFIXES: readonly string[] = [
  'sear', 'ric', 'hendin', 'rpc', 'svoronos', 'bmc', 'sng', 'crawford',
  'sydenham', 'cohen', 'rsc', 'meshorer', 'tjc', 'kraay'
];

/** Era markers. Captured as part of the era date, never as coin-type words. */
export const ERA_WORDS: readonly string[] = ['bc', 'bce', 'ad', 'ce'];

/* ---------------------------------------------------------------------------
 * ONE FLAT LIST FOR STOP_WORDS
 * ---------------------------------------------------------------------------
 * reference-tables.ts folds this into STOP_WORDS so `meaningfulTokens` drops
 * every one of them automatically. Note the group / non-coin words are NOT in
 * here: those need to stay visible so the detector can see them.
 * ------------------------------------------------------------------------- */
export const PHOTO_NOISE_WORDS: readonly string[] = [
  ...SIDE_WORDS.map(entry => entry.word),
  ...PHOTO_VARIANT_WORDS,
  ...GRADE_NOISE_WORDS,
  ...ERA_WORDS
];

/* ---------------------------------------------------------------------------
 * EXCLUDED-FROM-THE-AUTOMATED-IMPORT MARKERS
 * ---------------------------------------------------------------------------
 * Two groups of photographs on the owner's share are not pictures of one of
 * HIS coins, and he gave the same answer about both of them.
 *
 *   COUNTERFEITS      "Ignore the Fake coins."
 *
 *   MULTI-COIN SHOTS  "Never automatically attach nor offer as attachable in
 *                      the automated import. A user can try to manually
 *                      choose such a photo manually at a later time to attach
 *                      to a coin(s)."
 *
 * One answer, so one mechanism: see `detectAutoImportExclusion` in
 * non-coin-detector.ts. These words are NOT folded into STOP_WORDS and NOT
 * added to GROUP_SHOT_WORDS / NON_COIN_ITEM_WORDS, because the consequence is
 * different from `isNonCoin`: an excluded photo is also kept out of tier 3's
 * "Attach anyway..." rescue list, which an ordinary non-coin row still gets.
 *
 * *** THESE LISTS ARE ABOUT THE AUTOMATED DECISION AND NOTHING ELSE. ***
 * The owner, on why no file may ever be permanently off limits:
 *
 *   "I never want a picture file to be off limits from choosing to attach to
 *    a coin even if the descriptor has nothing relevant to the coin itself."
 *   "Maybe it's an article about the coin or something like that that I'd want
 *    to attach."
 *
 * So nothing keyed off these words may make a file unreadable, unlistable or
 * unselectable. They inform the matcher's decision; the per-coin gallery's
 * add-images path never consults them.
 * ------------------------------------------------------------------------- */

/**
 * Words that say the photographed coin is a COUNTERFEIT.
 *
 * All eight counterfeit files on the share carry one of the first two:
 *
 *     FAKE - 1860 3CS - VF - Obverse.jpg      (and its Reverse)
 *     1861 3CS - Obverse - FAKE.jpg           (and its Reverse)
 *     1860 Counterfeit 3CS - Obverse.jpg      (and its Reverse)
 *     1861 Counterfeit 3CS - Obverse.jpg      (and its Reverse)
 *
 * Every one of them carries a complete, valid descriptor -- year, denomination
 * and often a grade -- so without this list they score exactly as well against
 * a genuine coin as a genuine photo would. The owner holds five real 1861 3CS
 * records, which is precisely where that collision lands.
 *
 * "replica" is included although the share holds none today: it is the other
 * word the hobby uses for the same thing (and what the Hobby Protection Act
 * requires be stamped on one), it cannot mean anything else in a coin
 * filename, and the cost of a miss here is a silently mis-filed fake.
 *
 * *** "copy" IS DELIBERATELY ABSENT, AND MUST STAY ABSENT. ***
 * It is the third word the hobby uses -- and it is also the suffix Windows
 * puts on a duplicated file ("1881-S Morgan - Obverse - Copy.jpg"). There are
 * zero of either on the share today, but the day one appears it will
 * overwhelmingly be the Windows kind, and excluding an ordinary photograph of
 * a real coin is the error this whole module exists to avoid.
 */
export const COUNTERFEIT_MARKER_WORDS: readonly string[] = [
  'fake', 'counterfeit', 'replica'
];

/**
 * Words that say the photograph shows SEVERAL coins at once.
 *
 * The 22 multi-coin files on the share break down as:
 *
 *     collage   7   "20¢ Collage.jpg", "$3 Collage.jpg", "Gold $20 Collage.jpg",
 *                   "1875 3CN - Collage - BIG 3 - Small.jpg", ...
 *     group    11   all of them "Temp/Group PHOTO-2023-06-02-13-15-48.jpg"
 *                   and friends -- checked, every one is genuinely several coins
 *     montage   2   "1870 Proof Set Montage - Large.jpg" (and - Small)
 *     hoard     2   "1875 and 1876 3CN mini-hoard - Obverse.jpg" (and Reverse)
 *
 * "group" already appears in GROUP_SHOT_WORDS above, so those 11 were already
 * flagged `isNonCoin`. Listing it here as well is what additionally keeps them
 * out of the tier-3 rescue list, which is what the owner asked for.
 *
 * *** "set" IS DELIBERATELY ABSENT, AND MUST STAY ABSENT. ***
 * It looks like the obvious fifth entry -- "Gold Type Set.jpg" and
 * "1870 Proof Set Montage" both carry it. But the owner OWNS a great many
 * inventory records that genuinely ARE sets ("1942 Proof Set", "1950 Proof
 * Set", and dozens more), so a photograph saying "set" may legitimately belong
 * to a record saying "set". Excluding it would break a real pairing in order
 * to catch files that are already caught: the montage pair carries "Montage",
 * and "Gold Type Set" is `isNonCoin` through GROUP_SHOT_WORDS regardless.
 *
 * Also deliberately absent: "close-up" and "cleaned".
 *   "1882 O over S close-up.jpg" and "1887 Over 6 3CN Close-Up 1.jpg" are
 *   legitimate photographs OF the coin, just taken nearer to it.
 *   "1878-S Trade Dollar - AU58 Cleaned - Obverse.jpg" -- "cleaned" is a real
 *   condition descriptor the owner uses, and his security names carry
 *   "(CLEANED/PCGS)". It is part of the coin's description, not a reason to
 *   ignore the photograph.
 */
export const MULTI_COIN_MARKER_WORDS: readonly string[] = [
  'collage', 'montage', 'hoard', 'group'
];
