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

import { CoinRecord } from '../../types/coin.model';
import { MINT_CODES, MINT_NAMES } from './reference-tables';
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
}

/** A coin record plus its precomputed signature (parsed once per matchImages call). */
export interface CoinSignature {
  coin: CoinRecord;
  label: string;
  signature: Signature;
}

/** Display label for a coin, e.g. "Morgan Dollar 1881-S". */
export function describeCoin(coin: CoinRecord): string {
  const head = [coin.coinType, coin.denomination].filter(Boolean).join(' ').trim();
  const yearPart = [coin.year, coin.mintMark].filter(Boolean).join('-');
  return [head, yearPart].filter(Boolean).join(' ').trim() || `Coin ${coin.id}`;
}

/** Parse each coin exactly once and cache the result for this batch. */
export function buildCoinSignatures(inventory: CoinRecord[]): CoinSignature[] {
  return inventory.map(coin => ({
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

  // -- denomination ------------------------------------------------------
  const denomTokens = tokenize(coin.denomination ?? '');
  let denomination = findDenomination(denomTokens);

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

  const coinTypeTokens = meaningfulTokens(typeRemainder);

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
    grade: String(coin.grade ?? '').trim().toLowerCase() || null,
    certNumbers: certNumber ? [certNumber] : [],
    certCompanies: certCompany ? [certCompany] : [],
    tokens: [...typeTokens, ...denomTokens]
  };
}
