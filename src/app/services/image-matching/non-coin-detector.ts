 /*
 * Detects images that are not a photograph of one identifiable coin:
 *
 *     group shots    "Gold Coins.JPG", "Ancient Judaica - 8 coins - Obverse.jpg"
 *     non-coin items "Stamp - 11 - 3 cent.jpg", "3-cent paper - Large.jpg"
 *     containers     "Sovereign Proof Boxes.jpg"
 *     camera names   "Coin_026.JPG", "IM000025.JPG"
 *
 * A positive verdict is a hard veto (match-decider.ts returns 'none'), since
 * items like "Stamp - 11 - 3 cent" carry a valid-looking denomination and
 * would otherwise score well. Works on the raw filename because plurals, the
 * strongest group-shot signal, are lost once tokens are singularized.
  */

import {
  COUNTERFEIT_MARKER_WORDS,
  GROUP_SHOT_WORDS,
  MULTI_COIN_MARKER_WORDS,
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
 * Camera and scanner default names ("Coin_026", "IMG_0042", "DSC00031").
 * Detected explicitly so the UI can say why the file was skipped.
 */
const CAMERA_DEFAULT_NAME =
  /^(coin|coins|img|im|ims|dsc|dscn|dscf|pict|pic|photo|image|scan|mvimg|pxl|p|gopr|pano)[\s_-]*\d{1,8}$/i;

/** An explicit count of coins: "8 coins", "12 coin". */
const COUNTED_COINS = /\b\d{1,3}\s*coins?\b/i;

/**
 * Decide whether a filename describes something other than one single coin.
 * The first matching check wins.
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

  // 3. Items that are not coins (stamps, fractional currency).
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

  // 5. A plural denomination: "Gold Coins", "Canadian Cents", "Half Dimes".
  const plural = firstWordIn(text, PLURAL_DENOMINATION_WORDS);
  if (plural) {
    return {
      isNonCoin: true,
      reason: `The filename uses the plural "${plural}", so it shows more than one coin.`
    };
  }

  return IS_A_COIN;
}

 /*
 * Exclusion from the automated import (multi-coin shots).
 *
 * Stronger than `isNonCoin`: the photo is neither auto-attached nor offered
 * via tier 3's "Attach anyway..." link. It only affects the automated
 * matcher; the file stays listed in "Not imported" with a reason and can
 * still be attached by hand from the coin's image gallery.
  */

/** Which kind of thing the exclusion marker said this photograph was. */
export type AutoImportExclusionKind = 'multi-coin';

/** Whether (and why) a photograph is held back from the automated importer. */
export interface AutoImportExclusion {
  /**
   * True when the automated importer must neither attach this photograph nor
   * offer it as attachable. Manual attachment is unaffected.
   */
  excluded: boolean;
  /** Which rule fired, or null when the photograph is an ordinary one. */
  kind: AutoImportExclusionKind | null;
  /** Plain-English explanation for the read-only list, or null. */
  reason: string | null;
}

/** The "ordinary photograph" answer, shared so every caller gets one shape. */
const NOT_EXCLUDED: AutoImportExclusion = { excluded: false, kind: null, reason: null };

/**
 * Decide whether a photograph is held back from the automated import run.
 * Markers match as whole words, case-insensitively.
 *
 * @param rawText Extension-stripped basename only; a marker in a folder name
 *                ("Proofs/1870 Proof Set/...") says nothing about the file.
 */
export function detectAutoImportExclusion(rawText: string): AutoImportExclusion {
  const text = String(rawText ?? '').trim();
  if (!text) return NOT_EXCLUDED;

  // Counterfeits are not excluded; they are matched normally and kept apart
  // from genuine coins by the authenticity veto (see detectCounterfeit).
  const many = firstWordIn(text, MULTI_COIN_MARKER_WORDS);
  if (many) {
    return {
      excluded: true,
      kind: 'multi-coin',
      reason:
        `The filename says "${many}", so this photograph shows several coins at once. ` +
        'Group shots are never attached automatically and are not offered here. ' +
        'You can still attach it to any coin -- or to several -- by hand from ' +
        "the coin's image gallery."
    };
  }

  return NOT_EXCLUDED;
}


/**
 * Does this text say the coin is a counterfeit ("fake", "counterfeit",
 * "replica")? Used on both the filename and the coin record so they agree;
 * feeds the authenticity veto in match-vetoes.ts.
 */
export function detectCounterfeit(rawText: string): boolean {
  const text = String(rawText ?? '').trim();
  return !!text && firstWordIn(text, COUNTERFEIT_MARKER_WORDS) !== null;
}

/**
 * First word from `words` that appears in `text` as a whole word (so "part"
 * does not match inside "Sparta").
 */
function firstWordIn(text: string, words: readonly string[]): string | null {
  for (const word of words) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return word;
  }
  return null;
}
