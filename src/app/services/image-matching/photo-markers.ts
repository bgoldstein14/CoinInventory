/* ===========================================================================
 * photo-markers.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Reading the parts of a filename that describe the PHOTOGRAPH rather than
 *   the coin: which side is shown, which shot in a series it is, and which
 *   variant of the file it is. Public entry point is `parsePhotoMarkers`.
 *
 * WHY IT IS ITS OWN FILE
 *   This collection photographs most coins at least twice:
 *
 *       1870 1-cent NGC PF65RB - Obverse 2.jpg
 *       1870 10-cent - NGC PF64Cameo - Reverse 5.jpg
 *       1875CC - VF30 - 2 - Obverse.jpg
 *       1865 3CN - Choice VF - Obverse - Photo.jpg
 *       1904 $20 - PCGS MS63 - small.jpg
 *
 *   Those trailing bits do TWO different jobs at once, which is why they get
 *   their own module:
 *
 *   1. They must be kept OUT of the score. "Obverse" agreeing with "Obverse"
 *      is not evidence that two filenames show the same coin -- almost every
 *      filename says it. (The stripping itself is automatic: every word here
 *      is folded into STOP_WORDS via filename-vocabulary.ts, so
 *      `meaningfulTokens` drops them.)
 *
 *   2. They must be REPORTED, because the batch-import UI groups the obverse
 *      and reverse shots of one coin together, and needs to know which is
 *      which. So we return them as structured fields instead of just deleting
 *      them.
 *
 *   No imports from text-tokens on purpose: this module works on the raw
 *   filename (where the " - " separators are still visible) and is imported by
 *   reference-tables.ts's vocabulary chain, so staying dependency-free keeps
 *   the module graph acyclic.
 * =========================================================================== */

import { ParsedSide, PHOTO_VARIANT_WORDS, SIDE_WORDS } from './filename-vocabulary';

/** What a filename tells us about the photo itself. */
export interface PhotoMarkers {
  /** 'obverse' | 'reverse' | 'label', or null when the name does not say. */
  side: ParsedSide | null;
  /**
   * Which shot in a series this is: the "2" in "- Obverse 2" or in
   * "- VF30 - 2 - Obverse". Null when the name is not numbered.
   */
  take: number | null;
  /**
   * File variant: 'photo', 'orig', 'sharpened', 'small', 'large', ...
   * Null when the name does not say. Two files differing only by this are the
   * same coin at a different size or processing stage.
   */
  variant: string | null;
}

/**
 * The largest number we will believe is a shot number.
 *
 * Takes in this collection run 1..9 with the odd 10+. Capping at two digits
 * means a stray four-digit number can never be mistaken for a take, and a
 * year certainly cannot.
 */
const MAX_TAKE = 99;

/**
 * Segment separator: a hyphen with whitespace on at least one side.
 *
 * Written this way so that hyphens INSIDE a value survive: "1875-CC" and
 * "XF-AU" have no spaces around their hyphens and stay in one piece, while
 * " - " genuinely separates two fields.
 */
const SEGMENT_SEPARATOR = /\s+-+\s*|\s*-+\s+/;

/** Variant words, longest first, so "original" never matches as "orig". */
const VARIANTS_LONGEST_FIRST = [...PHOTO_VARIANT_WORDS].sort((a, b) => b.length - a.length);

/**
 * Read the photo markers out of an extension-stripped filename.
 *
 * Purely descriptive: nothing here affects the score. It only fills in the
 * fields the UI needs in order to group shots of the same coin.
 */
export function parsePhotoMarkers(text: string): PhotoMarkers {
  const segments = text.split(SEGMENT_SEPARATOR).map(s => s.trim()).filter(Boolean);

  return {
    side: findSide(text),
    take: findTake(text, segments),
    variant: findVariant(text)
  };
}

/**
 * Which face of the coin. First side word wins.
 *
 * Word boundaries matter here: without them the "rev" abbreviation would fire
 * inside "Revolt" ("67-68 CE 1st Revolt - Obverse - 2.jpg" is an obverse
 * shot of a First Revolt coin, not a reverse shot of something).
 */
function findSide(text: string): ParsedSide | null {
  let bestIndex = Number.MAX_SAFE_INTEGER;
  let bestSide: ParsedSide | null = null;

  for (const entry of SIDE_WORDS) {
    const match = new RegExp(`\\b${entry.word}\\b`, 'i').exec(text);
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      bestSide = entry.side;
    }
  }
  return bestSide;
}

/**
 * Which shot in the series. Two accepted forms, checked in this order:
 *
 *   A. a number glued to the side word    "- Obverse 2", "Reverse 5"
 *   B. a segment that is ONLY a number    "- VF30 - 2 - Obverse"
 *
 * Form A is checked first because it is unambiguous. Form B requires the
 * number to be the WHOLE segment, which is what stops the "11" in
 * "Stamp - 11 - 3 cent" style names from being confused with something
 * meaningful -- and equally stops a year or a cert number being read as a
 * take, since neither ever sits alone in a segment as one or two digits.
 */
function findTake(text: string, segments: string[]): number | null {
  // A. "Obverse 2" / "Reverse 5" / "Obv 3"
  for (const entry of SIDE_WORDS) {
    const match = new RegExp(`\\b${entry.word}\\b[\\s_-]*(\\d{1,2})\\b`, 'i').exec(text);
    if (match) {
      const value = Number(match[1]);
      if (value >= 1 && value <= MAX_TAKE) return value;
    }
  }

  // B. a standalone numeric segment. Scan from the END, because when a name
  //    carries several the trailing one is the shot number.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!/^\d{1,2}$/.test(segments[i])) continue;
    const value = Number(segments[i]);
    if (value >= 1 && value <= MAX_TAKE) return value;
  }

  return null;
}

/** 'photo' | 'orig' | 'sharpened' | 'small' | 'large' | ... First one wins. */
function findVariant(text: string): string | null {
  for (const word of VARIANTS_LONGEST_FIRST) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) return word;
  }
  return null;
}
