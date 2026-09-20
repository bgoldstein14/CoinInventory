/* ===========================================================================
 * filename-parser.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 1 for the image side: turning "1881-S Morgan Dollar obverse.jpg"
 *   into typed attributes. Public entry point is `parseFilename`; the rest
 *   (`parseText`, `extractYear`, `extractMintMark`) are the internal steps,
 *   plus `toSignature` which re-wraps the result for the scorer.
 *
 * WHY IT IS ITS OWN FILE
 *   This is the paranoid half of the matcher, and it is where most of the
 *   historical bugs lived. A filename is a free-text guess written by a human
 *   with a camera, so nearly every rule here exists to REFUSE something:
 *   "IMG_2024" is not a 2024 coin, the "s" in "reverse side" is not a mint
 *   mark, the "25" in a cert number is not a quarter. Concentrating all that
 *   suspicion in one file makes it obvious where to add the next refusal --
 *   and keeps it from contaminating coin-signature.ts, which is allowed to
 *   trust its input.
 *
 *   `parseFilename` is re-exported by ImageMatchingService unchanged: the UI
 *   and the tests both call it to show exactly what we understood.
 * =========================================================================== */

import { ParsedImageAttributes } from '../../types/coin.model';
import { Signature } from './coin-signature';
import {
  CAMERA_PREFIXES,
  CERT_COMPANIES,
  GRADE_PATTERN,
  MINT_CODES,
  MINT_NAMES
} from './reference-tables';
import {
  baseName,
  findDenomination,
  indexOfSequence,
  isPlausibleYear,
  meaningfulTokens,
  removeRange,
  stripExtension,
  tokenize
} from './text-tokens';

/**
 * Parse a single filename into typed attributes.
 * Exposed so the UI (and tests) can show exactly what we understood.
 */
export function parseFilename(imagePath: string): ParsedImageAttributes {
  const fileName = baseName(imagePath);
  const signature = parseText(stripExtension(fileName), { isFileName: true });

  const isEmpty =
    signature.year === null &&
    signature.mintMark === null &&
    signature.denomination === null &&
    signature.coinTypeTokens.length === 0 &&
    signature.certNumbers.length === 0;

  return {
    fileName,
    year: signature.year,
    mintMark: signature.mintMark,
    denomination: signature.denomination,
    denominationLabel: signature.denominationLabel,
    coinTypeTokens: signature.coinTypeTokens,
    grade: signature.grade,
    certNumbers: signature.certNumbers,
    certCompanies: signature.certCompanies,
    tokens: signature.tokens,
    isEmpty
  };
}

/** Re-wrap a parsed filename as an internal Signature for scoring. */
export function toSignature(parsed: ParsedImageAttributes): Signature {
  return {
    year: parsed.year,
    yearRangeEnd: null,
    mintMark: parsed.mintMark,
    denomination: parsed.denomination,
    denominationLabel: parsed.denominationLabel,
    coinTypeTokens: parsed.coinTypeTokens,
    grade: parsed.grade,
    certNumbers: parsed.certNumbers,
    certCompanies: parsed.certCompanies,
    tokens: parsed.tokens
  };
}

/** Parse free text (a filename) into a signature. */
function parseText(text: string, options: { isFileName: boolean }): Signature {
  // Keep `-` and `_` for now: mint-mark detection needs to see "1881-s".
  const separated = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = tokenize(separated);

  // -- year --------------------------------------------------------------
  const year = extractYear(tokens, options.isFileName);

  // -- mint mark (needs the separator-preserving string) -----------------
  const mintMark = extractMintMark(separated, tokens);

  // -- denomination ------------------------------------------------------
  const denomination = findDenomination(tokens);

  // -- grade / cert ------------------------------------------------------
  const grade = tokens.find(t => GRADE_PATTERN.test(t)) ?? null;
  const certCompanies = tokens.filter(t => CERT_COMPANIES.has(t));
  const certNumbers = tokens.filter(
    t => /^\d{5,12}$/.test(t) && Number(t) !== year
  );

  // -- coin type = whatever meaningful words are left --------------------
  let remainder = denomination
    ? removeRange(tokens, denomination.start, denomination.length)
    : [...tokens];

  remainder = remainder.filter(token => {
    if (year !== null && token === String(year)) return false;
    if (grade !== null && token === grade) return false;
    if (CERT_COMPANIES.has(token)) return false;
    if (certNumbers.includes(token)) return false;
    if (/^\d+$/.test(token)) return false;            // bare numbers say nothing
    if (token.length <= 1) return false;              // stray letters (incl. mint marks)
    if (mintMark && token === mintMark) return false; // e.g. the "cc" in "1881-cc"
    return true;
  });

  // Mint city names were already consumed as the mint mark.
  for (const entry of MINT_NAMES) {
    if (entry.words.every(w => remainder.includes(w)) && mintMark === entry.code) {
      remainder = remainder.filter(t => !entry.words.includes(t));
    }
  }

  return {
    year,
    yearRangeEnd: null,
    mintMark,
    denomination: denomination?.key ?? null,
    denominationLabel: denomination?.label ?? null,
    coinTypeTokens: meaningfulTokens(remainder),
    grade,
    certNumbers,
    certCompanies,
    tokens
  };
}

/**
 * Extract a year, but refuse camera sequence numbers.
 *
 * "IMG_2024.jpg" and "DSC_1998.jpg" are photos, not coins from 2024/1998.
 * A year-shaped number immediately preceded by a camera prefix is rejected.
 */
function extractYear(tokens: string[], isFileName: boolean): number | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!/^\d{4}$/.test(token)) continue;

    const value = Number(token);
    if (!isPlausibleYear(value)) continue;

    if (isFileName && i > 0 && CAMERA_PREFIXES.has(tokens[i - 1])) continue;

    return value;
  }
  return null;
}

/**
 * Extract a mint mark ONLY from unambiguous forms.
 *
 * Defect #6 was that any bare "s", "d" or "c" token anywhere in a filename
 * became a mint mark. Now a single letter must be positioned like a real
 * mint mark:
 *
 *   A. attached to the year        "1881-S", "1881_S", "1916 D"
 *   B. delimited on both sides     "morgan-cc-obverse"
 *   C. spelled out                 "carson city", "denver"
 *   D. explicitly labelled         "mintmark s", "mm: cc"
 *
 * If two different codes are found we return null -- ambiguous evidence is
 * treated as no evidence.
 */
function extractMintMark(separated: string, tokens: string[]): string | null {
  const found = new Set<string>();

  // A. year immediately followed by a separator and a 1-2 letter code.
  //    The trailing lookahead stops "1921_Peace" from yielding "p".
  const yearAdjacent = /(?:^|[^0-9a-z])(?:1[6-9]\d{2}|2[01]\d{2})[\s_-]*(cc|[pdswocm])(?![a-z0-9])/g;
  for (const match of separated.matchAll(yearAdjacent)) {
    found.add(match[1]);
  }

  // B. code fenced by explicit "-" or "_" on BOTH sides.
  const fenced = /[-_](cc|[pdswocm])[-_]/g;
  for (const match of separated.matchAll(fenced)) {
    found.add(match[1]);
  }

  // C. spelled-out mint names.
  for (const entry of MINT_NAMES) {
    const start = indexOfSequence(tokens, entry.words);
    if (start >= 0) found.add(entry.code);
  }

  // D. explicitly labelled.
  const labelled = /(?:^|[^a-z0-9])(?:mint[\s_-]*mark|mintmark|mm)[\s_-]*(cc|[pdswocm])(?![a-z0-9])/g;
  for (const match of separated.matchAll(labelled)) {
    found.add(match[1]);
  }

  if (found.size !== 1) return null; // zero = unknown, more than one = ambiguous
  const [code] = [...found];
  return MINT_CODES.has(code) ? code : null;
}
