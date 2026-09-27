/* ===========================================================================
 * filename-parser.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 1 for the image side: turning "1881-S Morgan Dollar obverse.jpg"
 *   into typed attributes. Public entry point is `parseFilename`, plus
 *   `toSignature` which re-wraps the result for the scorer.
 *
 *   Since the real-filename survey this file is an ORCHESTRATOR. Each awkward
 *   part of a real name got its own module, and this one calls them in the
 *   right order and assembles the answer:
 *
 *     year + mint mark   -> year-mint-parser.ts     ("1875CC", "1906-S")
 *     unit-bound values  -> denomination-units.ts   ("$20", "50c", "20-cent")
 *     word denominations -> reference-tables.ts     ("Half Dollar", "3CN")
 *     grade + cert co.   -> grade-parser.ts         ("Choice VF", "PF64Cameo")
 *     side / take / size -> photo-markers.ts        ("- Obverse 2", "- Small")
 *     ancients           -> catalog-refs.ts         ("Sear 6819", "67-68 CE")
 *     not-a-single-coin  -> non-coin-detector.ts    ("Gold Coins", "Stamp")
 *
 * WHY IT IS ITS OWN FILE
 *   This is the paranoid half of the matcher, and it is where most of the
 *   historical bugs lived. A filename is a free-text guess written by a human
 *   with a camera, so nearly every rule here exists to REFUSE something:
 *   "IMG_2024" is not a 2024 coin, the "s" in "reverse side" is not a mint
 *   mark, the "25" in a cert number is not a quarter, and "Stamp - 11 - 3
 *   cent" is not a three-cent coin. Concentrating all that suspicion in one
 *   place makes it obvious where to add the next refusal -- and keeps it from
 *   contaminating coin-signature.ts, which is allowed to trust its input.
 *
 *   `parseFilename` is re-exported by ImageMatchingService unchanged: the UI
 *   and the tests both call it to show exactly what we understood.
 *
 *   ORDER OF OPERATIONS MATTERS. Two places in particular:
 *     - the unit-bound denomination is tried BEFORE the word table, because
 *       "$20" is better evidence than any word in the same filename;
 *     - catalogue references are folded BEFORE bare digits are discarded,
 *       or the "6819" of "Sear 6819" would be gone before it could be joined.
 * =========================================================================== */

import { ParsedImageAttributes } from '../../types/coin.model';
import { findCatalogRefs, findEraDate, foldCatalogRefs } from './catalog-refs';
import { Signature } from './coin-signature';
import { findUnitBoundDenomination } from './denomination-units';
import { findCertCompanies, parseGrade } from './grade-parser';
import { detectNonCoin } from './non-coin-detector';
import { parsePhotoMarkers } from './photo-markers';
import { MINT_NAMES } from './reference-tables';
import {
  baseName,
  findDenomination,
  meaningfulTokens,
  removeRange,
  stripExtension,
  tokenize
} from './text-tokens';
import { extractMintMark, extractYear, gluedYearTokens } from './year-mint-parser';

/**
 * Parse a single filename into typed attributes.
 * Exposed so the UI (and tests) can show exactly what we understood.
 */
export function parseFilename(imagePath: string): ParsedImageAttributes {
  const fileName = baseName(imagePath);
  const rawText = stripExtension(fileName);

  // Keep `-` and `_` for now: mint-mark detection needs to see "1881-s".
  const separated = rawText
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = tokenize(separated);

  // -- year and mint mark (both need the separator-preserving string) ------
  const year = extractYear(tokens, true);
  const mintMark = extractMintMark(separated, tokens);

  // -- denomination -------------------------------------------------------
  // Unit-bound numbers first ("$20", "50c", "20-cent"); they are read from the
  // RAW text because tokenizing deletes the very sign that gives them meaning.
  const unitBound = findUnitBoundDenomination(rawText);
  const wordBased = unitBound ? null : findDenomination(tokens);

  const denomination = unitBound?.key ?? wordBased?.key ?? null;
  const denominationLabel = unitBound?.label ?? wordBased?.label ?? null;

  // -- grade, cert company, cert number -----------------------------------
  const { grade, consumedTokens: gradeTokens } = parseGrade(rawText);
  const certCompanies = findCertCompanies(rawText);
  const certNumbers = tokens.filter(t => /^\d{5,12}$/.test(t) && Number(t) !== year);

  // -- photo markers and ancients -----------------------------------------
  const photo = parsePhotoMarkers(rawText);
  const catalogRefs = findCatalogRefs(rawText);
  const eraDate = findEraDate(rawText);
  const nonCoin = detectNonCoin(rawText);

  // -- coin type = whatever meaningful words are left ---------------------
  const coinTypeTokens = extractCoinTypeTokens({
    tokens,
    wordBased,
    unitBoundTokens: unitBound?.consumedTokens ?? [],
    year,
    mintMark,
    gradeTokens,
    certNumbers
  });

  const isEmpty =
    year === null &&
    mintMark === null &&
    denomination === null &&
    coinTypeTokens.length === 0 &&
    certNumbers.length === 0;

  return {
    fileName,
    year,
    mintMark,
    denomination,
    denominationLabel,
    coinTypeTokens,
    grade,
    certNumbers,
    certCompanies,
    tokens,
    isEmpty,
    // --- fields added for the real-filename conventions -------------------
    side: photo.side,
    take: photo.take,
    photoVariant: photo.variant,
    catalogRefs,
    eraDate,
    isNonCoin: nonCoin.isNonCoin,
    nonCoinReason: nonCoin.reason
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

/**
 * Whatever is left after every recognised attribute has been taken out is the
 * coin's DESIGN name: "morgan", "mercury", "hawaii", "caracalla".
 *
 * Each removal below corresponds to something we have already scored on its
 * own. Leaving any of them in would be double-counting at best, and at worst
 * would make unrelated coins look alike (every PCGS coin sharing the token
 * "pcgs", every photo sharing "obverse").
 */
function extractCoinTypeTokens(input: {
  tokens: string[];
  wordBased: { start: number; length: number } | null;
  unitBoundTokens: string[];
  year: number | null;
  mintMark: string | null;
  gradeTokens: string[];
  certNumbers: string[];
}): string[] {
  const { tokens, wordBased, unitBoundTokens, year, mintMark, gradeTokens, certNumbers } = input;

  // The word-based denomination is removed by POSITION so that only the words
  // that formed the match go, not every later copy of them.
  let remainder = wordBased
    ? removeRange(tokens, wordBased.start, wordBased.length)
    : [...tokens];

  // Join "sear" + "6819" into "sear6819" BEFORE the bare-digit filter below
  // discards the number. Both sides of a comparison do this -- see
  // catalog-refs.ts.
  remainder = foldCatalogRefs(remainder);

  const consumed = new Set([
    ...unitBoundTokens,   // the "20" and "cent" of "20-cent", the "20" of "$20"
    ...gradeTokens,       // the "choice" and "vf" of "Choice VF"
    ...certNumbers,
    ...gluedYearTokens(remainder) // "1875cc" as a single token
  ]);

  remainder = remainder.filter(token => {
    if (consumed.has(token)) return false;
    if (year !== null && token === String(year)) return false;
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

  // `meaningfulTokens` drops the stop words, which now include every side,
  // photo-variant, grade and era word (see reference-tables.ts).
  return meaningfulTokens(remainder);
}
