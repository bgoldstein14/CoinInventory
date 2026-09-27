/* ===========================================================================
 * non-coin-detector.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Deciding that an image is NOT a photograph of one identifiable coin, so
 *   the matcher must not auto-assign it to anything. Public entry point is
 *   `detectNonCoin`.
 *
 * WHY IT IS ITS OWN FILE
 *   Roughly one image in ten on the share is not a single coin. Four different
 *   kinds, all from the real collection:
 *
 *     GROUP SHOTS    "Gold Coins.JPG", "20th Century Type Set.JPG",
 *                    "Ancient Judaica - 8 coins - Obverse.jpg",
 *                    "Canadian Cents - Part 1.jpg",
 *                    "Half Dimes and Cap and Rays.jpg"
 *     NON-COIN ITEMS "Stamp - 11 - 3 cent.jpg", "CSA Bond Coupon.jpg",
 *                    "3-cent paper - Large.jpg",
 *                    "3-cent Fractional - FR1227.jpg"
 *     CONTAINERS     "Sovereign Proof Boxes.jpg"
 *     CAMERA NAMES   "Coin_026.JPG", "IM000025.JPG"
 *
 *   Two of those are outright traps, and they are the reason this check is a
 *   hard veto rather than a score penalty:
 *
 *       "Stamp - 11 - 3 cent.jpg"        contains a valid "3 cent"
 *       "3-cent paper - Large.jpg"       contains a valid "3-cent"
 *
 *   Both would otherwise score respectably against a genuine Three Cent coin.
 *   A stamp filed under a coin is exactly the silent mis-attachment the whole
 *   matcher is built to avoid, so a positive verdict here overrides every
 *   score: match-decider.ts returns 'none' immediately and offers no
 *   candidates at all.
 *
 *   WHY IT WORKS ON THE RAW FILENAME
 *   Plurals are the single strongest group-shot signal ("Coins", "Cents",
 *   "Dimes"), but `text-tokens.singularize` has already destroyed them by the
 *   time tokens exist -- "coins" arrives as "coin", which is a perfectly
 *   normal word for a single-coin photo. So this module reads the raw name.
 * =========================================================================== */

import {
  GROUP_SHOT_WORDS,
  NON_COIN_ITEM_WORDS,
  PLURAL_DENOMINATION_WORDS
} from './filename-vocabulary';

/** Why (and whether) an image was ruled out as a single-coin photo. */
export interface NonCoinVerdict {
  /** True when this image must never be auto-assigned. */
  isNonCoin: boolean;
  /** Plain-English explanation for the UI, or null when it is a normal coin. */
  reason: string | null;
}

/** The "not a coin" answer, shared so every caller gets an identical shape. */
const IS_A_COIN: NonCoinVerdict = { isNonCoin: false, reason: null };

/**
 * Camera and scanner default names: a device prefix followed by nothing but a
 * sequence number. "Coin_026", "IM000025", "IMG_0042", "DSC00031".
 *
 * These are already very likely to parse to nothing at all, but naming them
 * explicitly lets the UI say WHY the file was skipped instead of shrugging.
 */
const CAMERA_DEFAULT_NAME =
  /^(coin|coins|img|im|ims|dsc|dscn|dscf|pict|pic|photo|image|scan|mvimg|pxl|p|gopr|pano)[\s_-]*\d{1,8}$/i;

/**
 * "8 coins", "3 Coins", "12 coin" -- an explicit count in front of the word.
 * Written separately from the plural list because "1 coin" is fine and this
 * needs to catch "8 coin" too (post-singularization spellings vary by hand).
 */
const COUNTED_COINS = /\b\d{1,3}\s*coins?\b/i;

/**
 * Decide whether a filename describes something other than one single coin.
 *
 * Checks run cheapest-and-most-certain first. The first hit wins; there is no
 * scoring or weighing here, because every one of these signals is on its own
 * sufficient reason to stop and ask the user.
 *
 * @param rawText Extension-stripped filename, original case and punctuation.
 */
export function detectNonCoin(rawText: string): NonCoinVerdict {
  const text = String(rawText ?? '').trim();
  if (!text) return IS_A_COIN;

  // 1. Camera / scanner default names. Nothing in them describes a coin.
  if (CAMERA_DEFAULT_NAME.test(text)) {
    return {
      isNonCoin: true,
      reason: `"${text}" is a camera default filename, so it carries no information about which coin it shows.`
    };
  }

  // 2. An explicit count of coins: "Ancient Judaica - 8 coins - Obverse".
  if (COUNTED_COINS.test(text)) {
    return {
      isNonCoin: true,
      reason: 'The filename counts several coins, so this is a group shot rather than one coin.'
    };
  }

  // 3. Items that are not coins. Highest-stakes check: a stamp or a piece of
  //    fractional currency can carry a perfectly valid-looking denomination.
  const item = firstWordIn(text, NON_COIN_ITEM_WORDS);
  if (item) {
    return {
      isNonCoin: true,
      reason: `The filename says "${item}", so this is not a coin and must not be attached to one.`
    };
  }

  // 4. Group / container words: sets, albums, boxes, "Part 1".
  const group = firstWordIn(text, GROUP_SHOT_WORDS);
  if (group) {
    return {
      isNonCoin: true,
      reason: `The filename says "${group}", so it shows a set or container rather than one coin.`
    };
  }

  // 5. A PLURAL denomination: "Gold Coins", "Canadian Cents", "Half Dimes".
  //    This is the check that needs the raw filename -- see the header.
  const plural = firstWordIn(text, PLURAL_DENOMINATION_WORDS);
  if (plural) {
    return {
      isNonCoin: true,
      reason: `The filename uses the plural "${plural}", so it shows more than one coin.`
    };
  }

  return IS_A_COIN;
}

/**
 * First word from `words` that appears in `text` as a whole word.
 *
 * Whole-word matching is essential rather than convenient: substring matching
 * would find "set" inside "Type Setting", "part" inside "Sparta", and "note"
 * inside "Notes" -- the sort of over-eager matching that produced the bugs
 * this whole directory was written to fix.
 */
function firstWordIn(text: string, words: readonly string[]): string | null {
  for (const word of words) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return word;
  }
  return null;
}
