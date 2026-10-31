/* ===========================================================================
 * coin-signature.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 1 for the COIN side of the comparison:
 *     - `Signature`, the shared shape both sides of a comparison are reduced
 *       to (a filename becomes one of these too -- see filename-parser.ts),
 *     - `CoinSignature`, a coin record bundled with its parsed signature,
 *     - `parseCoin`, which turns a CoinRecord's structured fields into a
 *       Signature,
 *     - `buildCoinSignatures`, the once-per-batch precompute,
 *     - `describeCoin`, the display label ("Morgan Dollar 1881-S").
 *
 * WHY IT IS ITS OWN FILE
 *   Parsing a coin RECORD and parsing a FILENAME are genuinely different jobs
 *   that happen to produce the same shape. A record hands us tidy, separate
 *   fields we can mostly trust; a filename hands us one messy string we have
 *   to be suspicious of. Keeping them apart stops the careful "don't trust
 *   this" rules of the filename parser from leaking into the record parser,
 *   where they would throw away good data.
 *
 *   `Signature` lives here because it is the contract the rest of the matcher
 *   is written against, and this is the file that defines what a well-formed
 *   one looks like.
 * =========================================================================== */

import { CoinRecord, StrikeKind } from '../../types/coin.model';
import { foldCatalogRefs } from './catalog-refs';
import { readTrustedDenominationText } from './denomination-units';
import { COUNTERFEIT_MARKER_WORDS } from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';
import { detectStrike } from './proof-strike';
import { MINT_CODES, MINT_NAMES, resolveEagleSeries } from './reference-tables';
import {
  findDenomination,
  isPlausibleYear,
  meaningfulTokens,
  removeDenominationTokens,
  removeRange,
  tokenize
} from './text-tokens';

/* ===========================================================================
 * Internal shapes
 * =========================================================================== */

/** Attributes for ONE side of a comparison (a filename or a coin record). */
export interface Signature {
  year: number | null;
  /** Coins may record a range like "1916-1945"; images never do. */
  yearRangeEnd: number | null;
  mintMark: string | null;
  denomination: string | null;
  denominationLabel: string | null;
  coinTypeTokens: string[];
  grade: string | null;
  certNumbers: string[];
  certCompanies: string[];
  tokens: string[];
  /**
   * How the coin was struck: 'proof', 'business', 'specimen' or 'unknown'.
   *
   * A first-class parsed attribute rather than something re-derived at
   * comparison time, so BOTH sides are read by the identical rules in
   * proof-strike.ts, exactly once each. A stated proof-against-business
   * disagreement is a hard veto (match-vetoes.ts).
   *
   * SAYING NOTHING IS SAYING 'business'. The owner: "The Proof descriptor
   * should always be part of the image file name as well as part of the
   * inventory description otherwise it's assumed the coin is a business
   * strike." So this field is 'unknown' only when the side was EMPTY -- no
   * type, no variety, no notes, no grade -- and 'unknown' is the only value
   * that disagrees with nothing.
   *
   * REMEMBER: a PROOFLIKE / PL / DMPL coin is 'business', not 'proof'. The
   * warning at the top of proof-strike.ts explains why that matters so much.
   */
  strike: StrikeKind;
}

/** A coin record plus its precomputed signature (parsed once per matchImages call). */
export interface CoinSignature {
  coin: CoinRecord;
  label: string;
  signature: Signature;
}

/**
 * Display label for a coin, e.g. "Twenty Cent 1876 — PCGS XF45".
 *
 * WHY THE GRADE AND GRADING COMPANY ARE IN HERE
 * This label is what the image importer puts at the top of each review group,
 * and it is the only thing the user reads when deciding whether a photo
 * belongs to this coin. Without the grade it is often not enough to tell two
 * records apart: a collection can hold an 1876 20¢ in XF45 and another in
 * MS63, and "Twenty Cent 1876" names both of them identically. The owner hit
 * exactly that while reviewing a folder of 20¢ photos and asked for the
 * header to be more complete.
 *
 * The grading company matters alongside the grade for the same reason —
 * "PCGS XF45" and "NGC XF45" are different slabs — and because the filenames
 * themselves usually carry it, so showing it lets the eye compare like with
 * like.
 *
 * Everything is optional and omitted when blank, so a raw ungraded coin still
 * reads cleanly as "Twenty Cent 1876" rather than trailing an empty dash.
 *
 * This is DISPLAY ONLY. The matcher scores against `Signature`, never against
 * this string, so enriching it cannot change which coin an image matches.
 */
export function describeCoin(coin: CoinRecord): string {
  const head = [coin.coinType, coin.denomination].filter(Boolean).join(' ').trim();
  const yearPart = [coin.year, coin.mintMark].filter(Boolean).join('-');
  const identity = [head, yearPart].filter(Boolean).join(' ').trim();

  // Grading company then grade, the way a slab label reads.
  const certPart = [coin.certCompany, coin.grade]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');

  if (!identity) return certPart ? `Coin ${coin.id} — ${certPart}` : `Coin ${coin.id}`;
  return certPart ? `${identity} — ${certPart}` : identity;
}

/**
 * Render a signature's year (or year range) for the explanation text.
 *
 * It lives beside `Signature` rather than with the scorer because three
 * different modules need it -- the scorer, the near-match test and the hard
 * vetoes -- and the vetoes are consulted BY the scorer. Keeping it here is
 * what stops those two files importing each other in a circle.
 */
export function formatYear(signature: Signature): string {
  if (signature.year === null) return 'unknown year';
  return signature.yearRangeEnd && signature.yearRangeEnd !== signature.year
    ? `${signature.year}-${signature.yearRangeEnd}`
    : String(signature.year);
}

/* ===========================================================================
 * COUNTERFEIT RECORDS AND THE AUTOMATED CANDIDATE POOL
 * ---------------------------------------------------------------------------
 * "Ignore the Fake coins" cuts BOTH ways, and the second way is the one that
 * is easy to miss.
 *
 * The obvious half is the photograph: a picture of a counterfeit must not be
 * filed under a genuine coin (non-coin-detector.ts owns that). The other half
 * is the RECORD. The owner holds three counterfeits as inventory rows --
 *
 *     1860 3CS - VF - FAKE
 *     1861 3CS - XF - FAKE
 *     1861 3CS - XF45 - FAKE
 *
 * -- and he also holds five GENUINE 1861 three-cent silvers. Leave the fakes
 * in the candidate pool and a photograph of a real 1861 3CS can auto-attach
 * to "1861 3CS - XF45 - FAKE", which is the identical error pointing the
 * other way.
 *
 * *** WHY THE FILTER IS HERE AND NOWHERE LOWER DOWN. ***
 * `buildCoinSignatures` is called from exactly one place in the application:
 * `ImageMatchingService.matchImages`. It is the AUTOMATED MATCHER'S view of
 * the inventory and nothing else's. Everything manual reads the inventory
 * directly and is completely unaffected:
 *
 *   - the free-text coin search (`row-decisions.searchCoins`, driven by
 *     `image-import/coin-lookup.ts`) iterates `InventoryService.inventory()`,
 *     so a fake record is still findable and still manually attachable;
 *   - the coin editor, the Add-coin path, the inventory grid, filters,
 *     sorting, reports, totals and melt values never touch this function;
 *   - the per-coin image gallery's add-images path never touches it either.
 *
 * The owner drew that boundary himself:
 *
 *   "I should be able to manually add a Fake coin to my inventory, just don't
 *    worry about automating such a thing."
 *
 * Putting the filter one level lower -- in the inventory service, or in
 * `searchCoins` -- would have taken his fakes out of the manual search too,
 * and the manual search is the escape hatch his whole answer depends on.
 * There is a test pinning that asymmetry.
 * ========================================================================= */

/**
 * Fields a counterfeit descriptor can honestly live in.
 *
 * `securityName` is not on {@link CoinRecord}; it is carried by the Quicken
 * importer's own record shape, and for this collection it is THE ONLY place
 * the word survives. His three fakes import with denomination "3CS", coinType
 * "Three Cent Silver" and grades "VF" / "XF" / "XF45" -- every declared field
 * identical to a genuine coin -- and the "FAKE" that distinguishes them lives
 * only in the raw Quicken security name. So it is read defensively here
 * rather than being ignored for not being in the interface.
 *
 * *** `notes` IS DELIBERATELY ABSENT. ***
 * It holds the Quicken transaction memo, which is prose about dealers and
 * history rather than a descriptor of the coin, and his real data contains
 * exactly the trap that matters:
 *
 *     "Sent 1860 PCI PF 3CS to a dealer (exchange for 1861 3CS FAKE)"
 *
 * That memo is attached to a GENUINE 1860 proof. Reading notes would throw a
 * real coin out of the automated pool because of a sentence about a different
 * coin entirely.
 */
const COUNTERFEIT_RECORD_FIELDS = [
  'coinType', 'variety', 'denomination', 'category', 'coinSet', 'grade', 'securityName'
] as const;

/**
 * Does this inventory record describe a COUNTERFEIT?
 *
 * Whole-token, case-insensitive, over the identity fields above -- the same
 * `\b`-anchored convention the filename side uses, and the same three marker
 * words, so the two sides can never form different opinions about what the
 * word "fake" means. See COUNTERFEIT_MARKER_WORDS in filename-vocabulary.ts
 * for why "copy" is not one of them.
 *
 * Exported so the test suite can assert the asymmetry directly: a record this
 * returns true for must still be searchable and manually attachable.
 */
export function isCounterfeitRecord(coin: CoinRecord): boolean {
  const bag = coin as unknown as Record<string, unknown>;
  const text = COUNTERFEIT_RECORD_FIELDS
    .map(field => (typeof bag[field] === 'string' ? bag[field] as string : ''))
    .filter(Boolean)
    .join(' ');
  if (!text) return false;

  return COUNTERFEIT_MARKER_WORDS.some(word => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

/**
 * Parse each coin exactly once and cache the result for this batch.
 *
 * Counterfeit records are dropped here -- see the long note above for why
 * this function, and only this function, is the right place for that.
 */
export function buildCoinSignatures(inventory: CoinRecord[]): CoinSignature[] {
  return inventory
    .filter(coin => !isCounterfeitRecord(coin))
    .map(coin => ({
      coin,
      label: describeCoin(coin),
      signature: parseCoin(coin)
    }));
}

/**
 * Build a signature from a coin RECORD (structured fields), not from a name.
 *
 * We trust the record's own fields first. The only inference is for
 * denomination: many records leave `denomination` blank and stuff everything
 * into `coinType` ("Mercury Dime"), so if `denomination` gives us nothing we
 * look for a denomination inside the type text instead.
 */
export function parseCoin(coin: CoinRecord): Signature {
  // -- year (supports "1881", "1916-1945", "c. 1881") --------------------
  const yearMatches = [...String(coin.year ?? '').matchAll(/\d{4}/g)].map(m => Number(m[0]));
  const validYears = yearMatches.filter(y => isPlausibleYear(y));
  const year = validYears.length ? validYears[0] : null;
  const yearRangeEnd = validYears.length > 1 ? validYears[validYears.length - 1] : null;

  /* -- denomination ------------------------------------------------------
   * TWO READERS, AND THE ORDER BETWEEN THEM MATTERS.
   *
   *   readTrustedDenominationText  reads the WHOLE FIELD as a face value with
   *                                a unit: "50 Cents", "20¢", "$20", "½¢".
   *                                Anchored end to end, so it either consumes
   *                                every character or answers null.
   *   findDenomination             scans the TOKENS for a known word pattern:
   *                                "Half Dollar", "Three Cent Nickel", "3CS".
   *
   * The whole-field reader goes FIRST, and it has to. `findDenomination`
   * matches a pattern anywhere in the token list, so it reads the "cent" out
   * of "50 Cents" (tokens ['50','cent']) and reports a ONE CENT piece -- a
   * record holding a perfectly ordinary half dollar was being filed as a
   * penny, and every 50¢ photograph then disagreed on denomination with its
   * own record. Trying the anchored reader first fixes that, and costs
   * nothing: it declines everything it does not fully understand, so
   * "Three Cent", "Dollar" and "3CS" still fall straight through to the word
   * table exactly as before.
   *
   * This is only safe on a RECORD, never on a filename: a denomination COLUMN
   * reading "50 Cents" cannot be anything else, whereas a filename saying the
   * same words might be a stamp or a price. See the header of
   * denomination-units.ts for that distinction. */
  const denomTokens = tokenize(coin.denomination ?? '');
  let denomination: { key: string; label: string } | null =
    readTrustedDenominationText(coin.denomination ?? '');

  if (!denomination) {
    denomination = findDenomination(denomTokens);
  }

  const typeText = [coin.coinType, coin.variety].filter(Boolean).join(' ');
  const typeTokens = tokenize(typeText);
  let typeRemainder = typeTokens;

  if (denomination) {
    // Denomination came from its own field; the type text keeps all its words
    // except any that merely restate the denomination.
    typeRemainder = removeDenominationTokens(typeTokens, denomination.key);
  } else {
    // Blank / unrecognised denomination field: look inside the type text.
    const inferred = findDenomination(typeTokens);
    if (inferred) {
      denomination = inferred;
      typeRemainder = removeRange(typeTokens, inferred.start, inferred.length);
    } else if (denomTokens.length) {
      // Unknown denomination wording (e.g. a foreign face value). Keep the
      // words as type evidence rather than throwing them away.
      typeRemainder = [...typeTokens, ...denomTokens];
    }
  }

  /* -- WHICH EAGLE? -------------------------------------------------------
   * The record side runs the identical year rule as the filename side, from
   * the identical function, so the two can never form different opinions
   * about which series a coin belongs to. A record reading "Gold Eagle" with
   * year 2015 is a $50 bullion coin; one reading "Eagle" with year 1907 is
   * the classic $10 piece; one with no year stays undecided.
   *
   * DELIBERATELY AFTER the token removal above. `removeDenominationTokens`
   * looks the key's own spellings up in DENOMINATION_RULES to strike them out
   * of the coin-type words, and it has to do that against the key the WORDS
   * produced ('gold eagle') -- resolving first would leave it hunting for
   * "fifty dollar" in a field that says "Gold Eagle" and the words would
   * survive as phantom coin-type evidence.
   *
   * The weight text is the denomination and type fields joined, so a record
   * whose type reads "Gold Eagle 1/4 oz" resolves to the $10 quarter-ounce
   * rather than the $50 default. See reference-tables.ts. */
  denomination = resolveEagleSeries(
    denomination,
    year,
    [coin.denomination, typeText].filter(Boolean).join(' ')
  );

  // Join catalogue references into single tokens the same way the filename
  // parser does, so a record whose variety reads "Sear 6819" produces the
  // token "sear6819" and can match a filename that says the same thing. Both
  // sides MUST fold, or they would never agree -- see catalog-refs.ts.
  const coinTypeTokens = meaningfulTokens(foldCatalogRefs(typeRemainder));

  // -- mint mark ---------------------------------------------------------
  // Records usually hold a bare code ("D"), but accept a spelled-out mint too.
  const rawMint = String(coin.mintMark ?? '').trim().toLowerCase().replace(/[^a-z\s]/g, '');
  const namedMint = MINT_NAMES.find(entry => entry.words.every(w => rawMint.includes(w)));
  const mintMark = MINT_CODES.has(rawMint) ? rawMint : (namedMint ? namedMint.code : (rawMint || null));

  // -- certification -----------------------------------------------------
  const certNumber = String(coin.certNumber ?? '').replace(/\D/g, '');
  const certCompany = String(coin.certCompany ?? '').trim().toLowerCase();

  return {
    year,
    yearRangeEnd,
    mintMark,
    denomination: denomination?.key ?? null,
    denominationLabel: denomination?.label ?? (coin.denomination || null),
    coinTypeTokens,
    // Normalized so "MS-63", "MS 63" and "ms63" all compare equal to the
    // "MS63" a filename would carry. See grade-parser.normalizeGrade.
    grade: normalizeGrade(coin.grade),
    certNumbers: certNumber ? [certNumber] : [],
    certCompanies: certCompany ? [certCompany] : [],
    tokens: [...typeTokens, ...denomTokens],

    /* -- how it was struck ------------------------------------------------
     * The grade decides whenever it can ("PF65RB" is a proof, "MS63" is not),
     * and only a record with NO grade falls back on its descriptive text. A
     * record that has both and mentions neither proof nor SP is a BUSINESS
     * STRIKE: the owner said the designation "should always be part of ...
     * the inventory description otherwise it's assumed the coin is a business
     * strike", so this is the inventory half of his sentence.
     *
     * `notes` is included because the owner said the proof designation "will
     * always be in the file and image descriptors", and on an ungraded record
     * the notes are often the only descriptor there is. It is also the one
     * free-text field here, so if a correct match is ever vetoed as
     * proof-against-business, the notes are the first place to look. The
     * grade-first ordering keeps the blast radius small: a graded coin's
     * notes cannot override its slab. */
    strike: detectStrike(
      [coin.coinType, coin.variety, coin.notes].filter(Boolean).join(' '),
      coin.grade
    )
  };
}
