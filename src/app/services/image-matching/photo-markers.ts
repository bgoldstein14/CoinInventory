 /*
 * Reads the parts of a filename that describe the photograph rather than the
 * coin: side shown, shot number and file variant.
 *
 *       1870 1-cent NGC PF65RB - Obverse 2.jpg
 *       1875CC - VF30 - 2 - Obverse.jpg
 *       1904 $20 - PCGS MS63 - small.jpg
 *
 * These words are excluded from scoring (they are stop words) but reported
 * so the batch-import UI can group a coin's obverse and reverse shots.
  */

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
   * Null when the name does not say.
   */
  variant: string | null;
}

/** Largest number accepted as a shot number, so years can't be read as takes. */
const MAX_TAKE = 99;

/**
 * Segment separator: a hyphen with whitespace on at least one side, so
 * "1875-CC" and "XF-AU" stay in one piece.
 */
const SEGMENT_SEPARATOR = /\s+-+\s*|\s*-+\s+/;

/** Variant words, longest first, so "original" never matches as "orig". */
const VARIANTS_LONGEST_FIRST = [...PHOTO_VARIANT_WORDS].sort((a, b) => b.length - a.length);

/**
 * Read the photo markers out of an extension-stripped filename. Descriptive
 * only; nothing here affects the score.
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
 * Which face of the coin. First side word wins. Word boundaries keep "rev"
 * from matching inside "Revolt".
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
 *   A. a number after the side word       "- Obverse 2", "Reverse 5"
 *   B. a segment that is only a number    "- VF30 - 2 - Obverse"
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

  // B. a standalone numeric segment; scan from the end, since the trailing
  //    one is the shot number.
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
