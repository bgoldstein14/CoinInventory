/* ===========================================================================
 * grade-parser.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Reading the GRADE and the CERTIFICATION COMPANY out of a raw filename,
 *   and normalizing a grade so the filename side and the coin-record side can
 *   be compared. Public entry points: `parseGrade`, `findCertCompanies`,
 *   `normalizeGrade`.
 *
 * WHY IT IS ITS OWN FILE
 *   Real filenames in this collection write grades six different ways, and
 *   several of them are destroyed by tokenizing (the "+" in "VF+" and the
 *   hyphen in "XF-AU" both vanish). So grades have to be read from the raw
 *   string, with their own set of narrow patterns:
 *
 *       numeric             1904 $20 - PCGS MS63 - small.jpg
 *       numeric + colour    1870 1-cent NGC PF65RB - Obverse 2.jpg
 *       numeric + cameo     1870 10-cent - NGC PF64Cameo - Reverse 5.jpg
 *       numeric + split     Israel 1982 5S ... ANACS PF69 DCAM - Obverse.jpeg
 *       range               1906-S $5 - XF-AU.jpg
 *       adjectival          1865 3CN - Choice VF - Obverse - Photo.jpg
 *       signed              1875 20c - VF+ - Obverse - Orig.jpg
 *       bare                1812 50c VG - Obverse - Small.jpg
 *
 * ---------------------------------------------------------------------------
 * HOW MUCH A GRADE IS WORTH (and why)
 * ---------------------------------------------------------------------------
 *   A GRADE ON ITS OWN IS WEAK EVIDENCE. Half the collection is XF or VF; a
 *   grade agreeing tells you almost nothing about WHICH coin this is. So the
 *   grade carries a small weight and, on its own, never counts as one of the
 *   two "strong attributes" the auto-assign gate demands.
 *
 *   A CERT COMPANY ON ITS OWN IS ALSO WEAK. Hundreds of coins are "PCGS".
 *
 *   TOGETHER THEY ARE STRONG. "PCGS MS63" narrows a collection down hard --
 *   the same company AND the same numeric grade is real corroboration. That
 *   combination rule lives in match-scorer.ts; this file only reads the values.
 * =========================================================================== */

import {
  GRADE_DESIGNATION_WORDS,
  GRADE_MODIFIER_WORDS
} from './filename-vocabulary';
import { CERT_COMPANIES } from './reference-tables';

/** What the grade patterns found, plus the tokens they used up. */
export interface ParsedGrade {
  /** Normalized grade, e.g. "ms63", "pf64cameo", "xf-au", "choicevf", "vg". */
  grade: string | null;
  /**
   * Tokens the grade consumed, so filename-parser.ts can keep them out of the
   * coin-type words. ("Choice VF" consumes both "choice" and "vf".)
   */
  consumedTokens: string[];
}

/* ---------------------------------------------------------------------------
 * GRADE BUILDING BLOCKS
 * ---------------------------------------------------------------------------
 * Assembled into regex alternations once, at module load, so we are not
 * rebuilding the same strings for every one of 2,000 filenames.
 * ------------------------------------------------------------------------- */

/**
 * Grade letters that are SAFE to recognise on their own.
 *
 * The single letters F (Fine) and G (Good) are missing on purpose -- see
 * SINGLE_LETTER_GRADES below.
 */
const MULTI = 'ms|pf|pr|sp|au|xf|ef|vf|vg|ag|fr|po|unc|bu';

/**
 * Single-letter grades. A lone "F" or "G" in a filename is usually NOT a
 * grade, so these are only accepted in two shapes that a stray letter could
 * never take: with a modifier in front ("Choice F") or alone in a segment
 * (" - F - "). Never bare, never mid-sentence.
 */
const SINGLE = 'g|f';

/** Longest first, so "cameo" is never matched as "cam" plus a leftover "eo". */
const DESIGNATION = [...GRADE_DESIGNATION_WORDS]
  .sort((a, b) => b.length - a.length)
  .join('|');

const MODIFIER = GRADE_MODIFIER_WORDS.join('|');

/**
 * NUMERIC: "MS63", "XF40", "VF30", "PF62CAM", "PF64Cameo", "PF69 DCAM".
 *
 * The separator between letters and number is `[\s-]?` -- at most ONE space
 * or hyphen. Allowing more would let "D - 2" and "F - 12" style photo markers
 * masquerade as grades.
 */
const NUMERIC_GRADE = new RegExp(
  `\\b(${MULTI}|${SINGLE})[\\s-]?(\\d{1,2})\\s*(${DESIGNATION})?\\b`,
  'i'
);

/**
 * RANGE: "XF-AU", "VF-XF". The hyphen must be TIGHT (no surrounding spaces),
 * which is what stops "VG - Obverse" from being read as the grade "VG-".
 * Checked before the signed form for exactly that reason.
 */
const RANGE_GRADE = new RegExp(`\\b(${MULTI}|${SINGLE})-(${MULTI}|${SINGLE})\\b`, 'i');

/** ADJECTIVAL: "Choice VF", "Choice F", "Gem BU", "About Unc". */
const MODIFIED_GRADE = new RegExp(`\\b(${MODIFIER})\\s+(${MULTI}|${SINGLE})\\b`, 'i');

/**
 * SIGNED: "VF+", "VG+", "XF-".
 * The sign must be glued to the letters -- no `\s*` before it -- so that
 * " - " separators are not mistaken for a minus.
 */
const SIGNED_GRADE = new RegExp(`\\b(${MULTI})([+-])(?![a-z0-9])`, 'i');

/** BARE: "VG", "XF", "AU" standing alone as a whole word. */
const BARE_GRADE = new RegExp(`\\b(${MULTI})\\b`, 'i');

/** An entire " - X - " segment that is just "F" or "G", optionally signed. */
const SINGLE_LETTER_GRADES = new RegExp(`^(${SINGLE})[+-]?$`, 'i');

/** Same segment splitter photo-markers.ts uses: a hyphen with space beside it. */
const SEGMENT_SEPARATOR = /\s+-+\s*|\s*-+\s+/;

/* ---------------------------------------------------------------------------
 * ENTRY POINTS
 * ------------------------------------------------------------------------- */

/**
 * Read a grade out of an extension-stripped filename.
 *
 * Patterns are tried MOST SPECIFIC FIRST and the first hit wins, because a
 * numeric grade is far better evidence than the bare letters inside it
 * ("PF69 DCAM" must not degrade to just "PF").
 *
 * Underscores are turned into spaces up front: "1921_Peace_Dollar_MS63" has
 * no word boundary before "MS63" otherwise, because "_" is a word character
 * as far as a regex is concerned.
 */
export function parseGrade(rawText: string): ParsedGrade {
  const text = String(rawText ?? '').replace(/_+/g, ' ');

  const numeric = NUMERIC_GRADE.exec(text);
  if (numeric) return build(numeric[0]);

  const range = RANGE_GRADE.exec(text);
  if (range) return build(range[0]);

  const modified = MODIFIED_GRADE.exec(text);
  if (modified) return build(modified[0]);

  const signed = SIGNED_GRADE.exec(text);
  if (signed) return build(signed[0]);

  const bare = BARE_GRADE.exec(text);
  if (bare) return build(bare[0]);

  // Last resort: a segment that is nothing but "F" or "G".
  for (const segment of text.split(SEGMENT_SEPARATOR)) {
    const trimmed = segment.trim();
    if (SINGLE_LETTER_GRADES.test(trimmed)) return build(trimmed);
  }

  return { grade: null, consumedTokens: [] };
}

/**
 * Grading services named in the filename, in the order they appear.
 *
 * Read from the RAW text rather than the token list because
 * `text-tokens.singularize` would otherwise chew the trailing "s" off the
 * acronyms and leave "pcg", "anac" and "seg" -- none of which are recognised.
 * (That is also fixed inside `singularize` itself, so stray copies of these
 * words cannot leak into the coin-type evidence.)
 */
export function findCertCompanies(rawText: string): string[] {
  const text = String(rawText ?? '');
  const found: Array<{ name: string; at: number }> = [];

  for (const company of CERT_COMPANIES) {
    const match = new RegExp(`\\b${company}\\b`, 'i').exec(text);
    if (match) found.push({ name: company, at: match.index });
  }

  return found.sort((a, b) => a.at - b.at).map(entry => entry.name);
}

/**
 * Put a grade into one canonical spelling so both sides of a comparison agree.
 *
 * Coin records and filenames spell the same grade differently:
 *   "MS-63" / "MS 63" / "ms63"     -> "ms63"
 *   "PF69 DCAM"                    -> "pf69dcam"
 *   "Choice VF"                    -> "choicevf"
 *   "XF-AU"                        -> "xf-au"   (hyphen KEPT)
 *
 * All whitespace is removed and everything is lowercased. A hyphen is removed
 * only when a digit sits on one side of it -- so the separator in "MS-63"
 * disappears while the genuinely meaningful hyphen in the RANGE "XF-AU"
 * survives. Without that distinction "XF-AU" and "XFAU" would be two
 * different grades and would never match.
 */
export function normalizeGrade(raw: unknown): string | null {
  const collapsed = String(raw ?? '').toLowerCase().replace(/\s+/g, '');
  if (!collapsed) return null;

  const withoutNumberSeparators = collapsed
    .replace(/-(?=\d)/g, '')
    .replace(/(\d)-/g, '$1');

  return withoutNumberSeparators || null;
}

/** Normalize a matched grade string and list the tokens it used up. */
function build(matchedText: string): ParsedGrade {
  return {
    grade: normalizeGrade(matchedText),
    // Lower-cased alphanumeric runs: "Choice VF" -> ["choice", "vf"].
    consumedTokens: matchedText.toLowerCase().match(/[a-z0-9]+/g) ?? []
  };
}
