 /*
 * Parses an image filename ("1881-S Morgan Dollar obverse.jpg") into typed
 * attributes. Delegates each part to its own module:
 *
 *     year + mint mark   -> year-mint-parser.ts     ("1875CC", "1906-S")
 *     unit-bound values  -> denomination-units.ts   ("$20", "50c", "20-cent")
 *     word denominations -> reference-tables.ts     ("Half Dollar", "3CN")
 *     grade + cert co.   -> grade-parser.ts         ("Choice VF", "PF64Cameo")
 *     side / take / size -> photo-markers.ts        ("- Obverse 2", "- Small")
 *     ancients           -> catalog-refs.ts         ("Sear 6819", "67-68 CE")
 *     not-a-single-coin  -> non-coin-detector.ts    ("Gold Coins", "Stamp")
 *
 * Filenames are free text, so most rules here exist to reject false readings:
 * "IMG_2024" is not a 2024 coin, the "s" in "reverse side" is not a mint mark.
  */

import { ParsedImageAttributes } from '../../types/coin.model';
import { findCatalogRefs, findEraDate, foldCatalogRefs } from './catalog-refs';
import { Signature } from './coin-signature';
import { findUnitBoundDenomination } from './denomination-units';
import { findCertCompanies, parseGrade } from './grade-parser';
import { detectAutoImportExclusion, detectCounterfeit, detectNonCoin } from './non-coin-detector';
import { parsePhotoMarkers } from './photo-markers';
import { detectStrike } from './proof-strike';
import { MINT_NAMES, isSpecificFormOf, resolveEagleSeries } from './reference-tables';
import {
  baseName,
  findDenomination,
  meaningfulTokens,
  removeRange,
  stripExtension,
  tokenize
} from './text-tokens';
import { extractMintMark, extractYear, gluedYearTokens } from './year-mint-parser';

/** Parse a single filename into typed attributes. */
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

  // Must run before the denomination block: only a filename cleared as a
  // single coin may read spaced face values like "3 cent" (so
  // "Stamp - 11 - 3 cent.jpg" is not a three-cent coin).
  const nonCoin = detectNonCoin(rawText);

  // Multi-coin shots ("20¢ Collage") are flagged here and kept out of the
  // automated import by match-decider.ts; they can still be attached by hand.
  const exclusion = detectAutoImportExclusion(rawText);

  // Year and mint mark need the separator-preserving string.
  const year = extractYear(tokens, true);
  const mintMark = extractMintMark(separated, tokens);

  /* Denomination: two readers.
   *   findDenomination            known spellings in the tokens ("Half Dollar", "3CN")
   *   findUnitBoundDenomination   a number with a unit in the raw text ("$20",
   *                               "50c", "20-cent"); raw because tokenizing
   *                               drops the sign that gives the number meaning.
   * A stated face value wins, but the unit-bound reader is given the word key
   * as context so it can tell a price from a face value ("Morgan Dollar $50"
   * is what the coin cost). `wordBased` stays null when the unit-bound reader
   * answered, so only the winning reader's words are stripped from the type. */
  const wordMatch = findDenomination(tokens);

  // Context-only read: "50 cent" still counts as naming a coin here, so the
  // "$20" in "1913 50-Cent Canadian $20" reads as a price, not a Double Eagle.
  const wordContext = wordMatch ?? findDenomination(tokens, { allowCountedCent: true });

  // Spaced face values ("1866 2 cent") are only read for filenames the
  // non-coin detector has cleared.
  const unitBoundRead = findUnitBoundDenomination(
    rawText,
    wordContext?.key ?? null,
    { allowSpacedCent: !nonCoin.isNonCoin }
  );

  // When the words name a more specific form of the face value ("3-cent
  // silver" vs plain 'three cent'), the words win; the vague key would also
  // be compatible with a Three Cent Nickel record and defeat the veto.
  const wordsAreSharper = !!unitBoundRead && isSpecificFormOf(wordMatch?.key, unitBoundRead.key);
  const unitBound = wordsAreSharper ? null : unitBoundRead;
  const wordBased = unitBound ? null : wordMatch;

  // "Eagle" depends on the year (classic $10 gold vs modern bullion); the
  // vague 'gold eagle' key is resolved here. See resolveEagleSeries.
  const resolved = resolveEagleSeries(unitBound ?? wordBased, year, rawText);

  const denomination = resolved?.key ?? null;
  const denominationLabel = resolved?.label ?? null;

  // Grade, cert company, cert number
  const { grade, consumedTokens: gradeTokens } = parseGrade(rawText);
  const certCompanies = findCertCompanies(rawText);
  const certNumbers = tokens.filter(t => /^\d{5,12}$/.test(t) && Number(t) !== year);

  // Photo markers and ancients
  const photo = parsePhotoMarkers(rawText);
  const catalogRefs = findCatalogRefs(rawText);
  const eraDate = findEraDate(rawText);

  // Strike is read from the raw name ("proof-like", "PF65RB" don't survive
  // tokenizing). A name silent on strike reads as 'business' (see
  // proof-strike.ts). Only the basename is parsed, so folder names like
  // "Early Proofs" have no effect.
  const strike = detectStrike(rawText, grade);

  // Coin type = whatever meaningful words are left
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
    side: photo.side,
    take: photo.take,
    photoVariant: photo.variant,
    catalogRefs,
    eraDate,
    isNonCoin: nonCoin.isNonCoin,
    nonCoinReason: nonCoin.reason,
    excludedFromAutoImport: exclusion.excluded,
    autoImportExclusionReason: exclusion.reason,
    counterfeit: detectCounterfeit(rawText),
    strike
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
    tokens: parsed.tokens,
    // parseFilename always sets `strike`; a hand-built object without it
    // defaults to 'unknown', which never triggers a veto.
    strike: parsed.strike ?? 'unknown',
    counterfeit: parsed.counterfeit ?? false
  };
}

/**
 * What remains after removing every recognised attribute is the coin's design
 * name ("morgan", "mercury", "caracalla"). Removed attributes are scored
 * separately; leaving them in would double-count and make unrelated coins
 * look alike (every photo sharing "obverse").
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

  // Join "sear" + "6819" into "sear6819" before the bare-digit filter below
  // discards the number.
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

  // Stop words include side, photo-variant, grade and era words.
  return meaningfulTokens(remainder);
}
