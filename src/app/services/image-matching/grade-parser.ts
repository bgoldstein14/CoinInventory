 /*
 * Reads the grade and certification company from a raw filename, and
 * normalizes grades so filenames and coin records compare equal.
 *
 * Grades are read from the raw string because tokenizing loses "+" and the
 * hyphen in "XF-AU". Shapes handled:
 *
 *       numeric             1904 $20 - PCGS MS63 - small.jpg
 *       numeric + colour    1870 1-cent NGC PF65RB - Obverse 2.jpg
 *       numeric + split     Israel 1982 5S ... ANACS PF69 DCAM - Obverse.jpeg
 *       range               1906-S $5 - XF-AU.jpg
 *       adjectival          1865 3CN - Choice VF - Obverse - Photo.jpg
 *       signed              1875 20c - VF+ - Obverse - Orig.jpg
 *       bare                1812 50c VG - Obverse - Small.jpg
 *
 * How much a grade is worth (weak alone, strong with a cert company) is
 * decided in match-scorer.ts.
  */

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

/** Grade letters safe to recognise on their own. */
const MULTI = 'ms|pf|pr|sp|au|xf|ef|vf|vg|ag|fr|po|unc|bu';

/**
 * Single-letter grades (Fine, Good). A lone "F" or "G" is usually not a grade,
 * so these are only accepted after a modifier ("Choice F") or alone in a
 * segment (" - F - ").
 */
const SINGLE = 'g|f';

/** Longest first, so "cameo" is never matched as "cam" plus a leftover "eo". */
const DESIGNATION = [...GRADE_DESIGNATION_WORDS]
  .sort((a, b) => b.length - a.length)
  .join('|');

const MODIFIER = GRADE_MODIFIER_WORDS.join('|');

/**
 * Numeric: "MS63", "PF62CAM", "PF69 DCAM". At most one space or hyphen
 * between letters and number, so photo markers like "F - 12" don't match.
 */
const NUMERIC_GRADE = new RegExp(
  `\\b(${MULTI}|${SINGLE})[\\s-]?(\\d{1,2})\\s*(${DESIGNATION})?\\b`,
  'i'
);

/**
 * Range: "XF-AU". The hyphen must be tight, so "VG - Obverse" is not "VG-";
 * checked before the signed form for that reason.
 */
const RANGE_GRADE = new RegExp(`\\b(${MULTI}|${SINGLE})-(${MULTI}|${SINGLE})\\b`, 'i');

/** Adjectival: "Choice VF", "Choice F", "Gem BU", "About Unc". */
const MODIFIED_GRADE = new RegExp(`\\b(${MODIFIER})\\s+(${MULTI}|${SINGLE})\\b`, 'i');

/** Signed: "VF+", "XF-". The sign must be glued on, so " - " is not a minus. */
const SIGNED_GRADE = new RegExp(`\\b(${MULTI})([+-])(?![a-z0-9])`, 'i');

/** Bare: "VG", "XF", "AU" as a whole word. */
const BARE_GRADE = new RegExp(`\\b(${MULTI})\\b`, 'i');

/** An entire " - X - " segment that is just "F" or "G", optionally signed. */
const SINGLE_LETTER_GRADES = new RegExp(`^(${SINGLE})[+-]?$`, 'i');

/** Same segment splitter photo-markers.ts uses: a hyphen with space beside it. */
const SEGMENT_SEPARATOR = /\s+-+\s*|\s*-+\s+/;

/**
 * Read a grade out of an extension-stripped filename. Patterns are tried most
 * specific first ("PF69 DCAM" must not degrade to "PF"). Underscores become
 * spaces because "_" is a regex word character and would block `\b`.
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
 * Grading services named in the filename, in the order they appear. Read from
 * raw text so singularizing can't turn "pcgs" into "pcg".
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
 * Put a grade into one canonical spelling so both sides of a comparison agree:
 *   "MS-63" / "MS 63" / "ms63"     -> "ms63"
 *   "PF69 DCAM"                    -> "pf69dcam"
 *   "XF-AU"                        -> "xf-au"
 * Hyphens are dropped only next to a digit, so a range keeps its hyphen.
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
