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
 *     - the word table is CONSULTED first but the unit-bound number still
 *       WINS: "$20" is better evidence than any word, yet the dollar rule
 *       needs to know what the words said before it can tell a face value
 *       from a price ("Morgan Dollar $50" is a purchase, not a $50 coin).
 *       See the denomination block below, and the long explanation in
 *       denomination-units.ts;
 *     - catalogue references are folded BEFORE bare digits are discarded,
 *       or the "6819" of "Sear 6819" would be gone before it could be joined.
 * =========================================================================== */

import { ParsedImageAttributes } from '../../types/coin.model';
import { findCatalogRefs, findEraDate, foldCatalogRefs } from './catalog-refs';
import { Signature } from './coin-signature';
import { findUnitBoundDenomination } from './denomination-units';
import { findCertCompanies, parseGrade } from './grade-parser';
import { detectAutoImportExclusion, detectNonCoin } from './non-coin-detector';
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

  /* -- IS THIS A PHOTOGRAPH OF ONE COIN AT ALL? --------------------------
   * Moved to the TOP of the function (it used to sit further down, beside
   * the other descriptive readers) because the denomination block below now
   * depends on its answer.
   *
   * WHY. The owner confirmed that he writes face values with a space --
   * "Yes, read them as face values" for "2 cent", "3 cent", "20 cent" -- and
   * the hyphen in "20-cent" was previously the whole of the matcher's
   * defence against this real filename:
   *
   *     Stamp - 11 - 3 cent.jpg
   *
   * Reading his spaced forms means that defence has to come from somewhere
   * else, and this is the somewhere else: the detector reads the words that
   * say what the thing IS ("stamp", "paper", "fractional", "bond", "note"),
   * which is better evidence than punctuation ever was. A filename it has
   * NOT cleared never gets the spaced reading. See the SPACED_CENT comment
   * in denomination-units.ts for the full argument.
   *
   * Nothing else about this call changed, and the result is reported on the
   * parsed attributes exactly as before. */
  const nonCoin = detectNonCoin(rawText);

  /* -- IS THIS PHOTOGRAPH ONE THE AUTOMATED IMPORT SHOULD TOUCH AT ALL? --
   * Counterfeits ("FAKE - 1860 3CS - VF - Obverse") and shots of several
   * coins at once ("20¢ Collage", "1875 and 1876 3CN mini-hoard") are held
   * back from the automated run entirely -- not auto-attached, and not
   * offered in tier 3's "Attach anyway..." list either.
   *
   * REPORTED HERE, ENFORCED IN match-decider.ts. This is deliberately only a
   * READING of the name. It changes nothing about how the file is parsed,
   * scored or listed, and in particular it does NOT feed `allowSpacedCent`
   * below the way `isNonCoin` does -- every existing parse comes out byte for
   * byte as before. The owner's rule is about what the AUTOMATED DECISION may
   * do with the photograph, never about the photograph itself:
   *
   *   "I never want a picture file to be off limits from choosing to attach
   *    to a coin even if the descriptor has nothing relevant to the coin
   *    itself."
   *
   * `rawText` is the BASENAME, which is what makes folder names irrelevant:
   * "Proofs/1870 Proof Set/Archive/IM000037.JPG" is judged on "IM000037"
   * alone. See non-coin-detector.ts for the marker lists and for the three
   * words (`copy`, `set`, `cleaned`) that are deliberately NOT markers. */
  const exclusion = detectAutoImportExclusion(rawText);

  // -- year and mint mark (both need the separator-preserving string) ------
  const year = extractYear(tokens, true);
  const mintMark = extractMintMark(separated, tokens);

  /* -- denomination -------------------------------------------------------
   * TWO READERS, AND A UNIT-BOUND NUMBER STILL WINS.
   *
   *   findDenomination            scans the TOKENS for a known spelling:
   *                               "Peace Dollar", "Half Dollar", "3CN".
   *   findUnitBoundDenomination   reads a number with a unit out of the RAW
   *                               text -- "$20", "50<cent>", "20-cent" --
   *                               raw, because tokenizing deletes the very
   *                               sign that gives the number its meaning.
   *
   * The words are read FIRST and handed to the unit-bound reader, which is
   * the one ordering change this pair has ever needed. It is not a change of
   * authority: a stated face value is still the better evidence and still
   * wins whenever it survives. It is CONTEXT. "$20" in a name that says
   * nothing else is a Double Eagle; "$50" in a name that already says
   * "Morgan Dollar" is what the owner PAID, because a coin has exactly one
   * face value and that name has already given it. Only the words can reveal
   * that, so the dollar rule has to see them before it decides. The whole
   * rule, and why it is true of coins rather than merely of this code, is in
   * the DOLLAR_FACE_VALUES header in denomination-units.ts.
   *
   * `wordBased` stays null whenever the unit-bound reader answered, exactly
   * as before: it is also what tells `extractCoinTypeTokens` below WHICH
   * words to strike out as the denomination, and only the reader that
   * actually supplied the answer may do that. */
  const wordMatch = findDenomination(tokens);

  /* The face-value reader is told what the WORDS said, so it can tell a face
   * value from a price. "50 cent" has to count as the words naming a coin for
   * that purpose even though `findDenomination` now (rightly) refuses to call
   * it a ONE CENT piece -- otherwise the "$20" in
   * "1913 50-Cent Canadian $20 - Obverse.jpg" stops looking like a price and
   * starts looking like a Double Eagle. Hence the second, context-only read;
   * see FindDenominationOptions.allowCountedCent in text-tokens.ts. */
  const wordContext = wordMatch ?? findDenomination(tokens, { allowCountedCent: true });

  /* `allowSpacedCent` is what turns "1866 2 cent - PCGS PF64RB - Obverse.jpg"
   * into a TWO CENT piece instead of nothing at all. It is granted only to a
   * filename the non-coin detector has cleared, which is how the three
   * traps in the corpus stay out:
   *
   *     Stamp - 11 - 3 cent.jpg          "stamp"      -> never asked
   *     3-cent paper - Large.jpg         "paper"      -> never asked
   *     3-cent Fractional - FR1227.jpg   "fractional" -> never asked
   *
   * (The second and third are hyphenated, so the face-value reader would
   * have answered for them either way; the non-coin veto in
   * match-decider.ts is what has always kept them out of the import, and
   * still does. The first is the one the hyphen rule was protecting, and it
   * is the one this flag now protects instead.) */
  const unitBoundRead = findUnitBoundDenomination(
    rawText,
    wordContext?.key ?? null,
    { allowSpacedCent: !nonCoin.isNonCoin }
  );

  /* ...WITH ONE EXCEPTION: THE WORDS MAY BE SHARPER THAN THE FACE VALUE.
   *
   * A face value can only say HOW MANY CENTS. For most denominations that
   * settles it -- fifty cents is a Half Dollar and nothing else. For three
   * cents and five cents it does not:
   *
   *     1864 3-cent silver - PF64 - Obverse.jpg
   *
   * The face-value reader sees "3-cent" and answers the vague 'three cent';
   * the word table sees "3 cent silver" and answers 'three cent silver'. The
   * two AGREE -- one is the general form of the other -- but only the second
   * one names the coin, and the owner reported the consequence of preferring
   * the first: his 1867 Three Cent NICKEL record kept being offered
   * photographs of his 1867 Three Cent SILVER proof, because the vague key is
   * compatible with either and so the denomination veto never fired.
   *
   * So when the words give a SPECIFIC form of what the face value gave, the
   * words win. This is not the face value losing its authority -- the two
   * answers do not contradict each other, one is simply more precise, and
   * precision is what the veto needs. Every other case is untouched: a
   * disagreement (words say "Morgan Dollar", digits say "$50") is still the
   * face value's business and is still resolved inside
   * findUnitBoundDenomination, which is why the word key is passed to it. */
  const wordsAreSharper = !!unitBoundRead && isSpecificFormOf(wordMatch?.key, unitBoundRead.key);
  const unitBound = wordsAreSharper ? null : unitBoundRead;
  const wordBased = unitBound ? null : wordMatch;

  /* WHICH EAGLE? The word "Eagle" (or "Gold Eagle") is the one denomination
   * whose meaning depends on WHEN the coin was struck: the classic $10 gold
   * piece ran 1795-1933 and the modern bullion series started in 1986, with
   * nothing in between. The tables above see only words, so they hand back
   * the deliberately vague key 'gold eagle'; this is where the year it just
   * read turns that into a real face value.
   *
   * It is a no-op for every other denomination, and a no-op for an Eagle with
   * no year -- an undated "Eagle" stays vague on purpose rather than guessing
   * a series. The whole rule, with both date ranges, is in
   * reference-tables.ts beside `resolveEagleSeries`.
   *
   * `rawText` is passed so a weight word ("1 oz", "1/4 oz") can name the
   * exact bullion size; that is a refinement, and it is only consulted once
   * the year has already established that the coin is modern. */
  const resolved = resolveEagleSeries(unitBound ?? wordBased, year, rawText);

  const denomination = resolved?.key ?? null;
  const denominationLabel = resolved?.label ?? null;

  // -- grade, cert company, cert number -----------------------------------
  const { grade, consumedTokens: gradeTokens } = parseGrade(rawText);
  const certCompanies = findCertCompanies(rawText);
  const certNumbers = tokens.filter(t => /^\d{5,12}$/.test(t) && Number(t) !== year);

  // -- photo markers and ancients -----------------------------------------
  const photo = parsePhotoMarkers(rawText);
  const catalogRefs = findCatalogRefs(rawText);
  const eraDate = findEraDate(rawText);
  // `nonCoin` is read at the top of the function now -- the denomination
  // block needs its answer. See the comment there.

  /* -- proof, specimen, or (if the name stays quiet) BUSINESS STRIKE -------
   * Read from the RAW filename, because the only reliable written forms are
   * destroyed by tokenizing: "proof-like" loses its hyphen and "PF65RB" is
   * only meaningful as the whole grade.
   *
   * A NAME THAT SAYS NOTHING ABOUT THE STRIKE ANSWERS 'business', NOT
   * 'unknown'. This is the image half of the owner's rule: "The Proof
   * descriptor should always be part of the image file name as well as part
   * of the inventory description otherwise it's assumed the coin is a
   * business strike." Since every real filename has SOME text, essentially
   * every photograph now makes a positive statement about its strike -- and
   * a quiet filename is therefore disqualified from a proof record by
   * match-vetoes.ts. That is deliberate; see the carve-out note in that file.
   *
   * NOTE FOR ANYONE WORRIED ABOUT THE "Early Proofs" FOLDER: directory names
   * never reach here. `baseName(imagePath)` at the top of this function keeps
   * every path component except the final filename out of the parser, so a
   * folder called "Early Proofs" cannot make its contents look like proofs.
   * That is deliberate and there is a test for it. */
  const strike = detectStrike(rawText, grade);

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
    nonCoinReason: nonCoin.reason,
    excludedFromAutoImport: exclusion.excluded,
    autoImportExclusionReason: exclusion.reason,
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
    /* `strike` is optional on the public ParsedImageAttributes (every field
     * added after the original shape is, so old callers keep compiling), but
     * `parseFilename` always fills it in -- and since the owner's rule makes
     * a quiet filename a BUSINESS strike, what it fills in is essentially
     * never 'unknown'.
     *
     * The default stays 'unknown' all the same, and that is the one place it
     * is still the right answer. A hand-built attributes object that omits
     * the field has not stayed QUIET about the strike; it has no filename
     * behind it at all. 'unknown' disagrees with nothing, so such an object
     * can never cause a veto -- which is what we want from a caller that
     * never promised to fill the field in. */
    strike: parsed.strike ?? 'unknown'
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
