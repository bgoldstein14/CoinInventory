 /*
 * Coin side of the comparison: turns a CoinRecord's structured fields into a
 * `Signature`, the shape both filenames and records are reduced to.
 * Kept separate from filename-parser.ts because record fields are mostly
 * trustworthy while filenames need defensive parsing.
  */

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

 /*
 * Denomination label lookup.
 *
 * A coin has two denomination fields that may disagree: `denominationId` (the
 * canonical link, often null) and `denomination` (the source text, never
 * rewritten, e.g. "Pillar Dollar" while the id says "8 Reales"). The id's
 * label is fed to the existing string logic so the coin isn't vetoed against
 * the wrong denomination.
 *
 * The matcher never performs the lookup itself. The caller passes a snapshot
 * taken once per import, because matching runs in chunks across awaits and a
 * lookup landing mid-batch would split one folder across two behaviours. An
 * empty snapshot gives plain text-only matching.
  */

/**
 * The fields this module needs from a denominations row. Declared locally so
 * the matcher stays independent of the rest of the app (pure, Node-testable).
 */
export interface LabelledDenomination {
  denominationId: number;
  label: string;
  isActive: boolean;
}

/** `DenominationId` -> `Label`, for the ACTIVE rows of one lookup fetch. */
export type DenominationLabels = ReadonlyMap<number, string>;

/**
 * Freeze the denominations lookup into an id -> Label table. Inactive
 * (soft-deleted) rows are left out, so a coin pointing at one falls back to
 * its recorded text.
 */
export function denominationLabelSnapshot(
  rows: readonly LabelledDenomination[]
): DenominationLabels {
  const labels = new Map<number, string>();
  for (const row of rows) {
    if (row.isActive) labels.set(row.denominationId, row.label);
  }
  return labels;
}

/**
 * The string the denomination readers are given for this coin: the linked
 * label when there is one, otherwise the recorded text.
 *
 * A blank recorded text ignores the label: the app never creates an id beside
 * blank text, and a coin that recorded nothing should not gain a denomination
 * that could veto the right match. Whitespace counts as blank.
 */
function denominationTextOf(coin: CoinRecord, labels?: DenominationLabels | null): string {
  const recorded = String(coin.denomination ?? '');
  if (!recorded.trim()) return recorded;

  const id = coin.denominationId;
  if (id === null || id === undefined || !labels) return recorded;

  const label = labels.get(id);
  return label && label.trim() ? label : recorded;
}

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
   * How the coin was struck (see proof-strike.ts). Saying nothing means
   * 'business'; 'unknown' only when the side was empty. Prooflike is 'business'.
   */
  strike: StrikeKind;
  /**
   * True when this side says the coin is counterfeit. Silence means genuine.
   * A stated mismatch is a hard veto. Optional; absent reads as genuine.
   */
  counterfeit?: boolean;
}

/** A coin record plus its precomputed signature (parsed once per matchImages call). */
export interface CoinSignature {
  coin: CoinRecord;
  label: string;
  signature: Signature;
}

/**
 * Display label for a coin, e.g. "Twenty Cent 1876 — PCGS XF45". The grade
 * and company help the user tell apart records of the same date. Blank parts
 * are omitted. Display only; never used for scoring.
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
 * Render a signature's year (or year range) for explanation text. Lives here
 * so the scorer, near-match and vetoes can share it without an import cycle.
 */
export function formatYear(signature: Signature): string {
  if (signature.year === null) return 'unknown year';
  return signature.yearRangeEnd && signature.yearRangeEnd !== signature.year
    ? `${signature.year}-${signature.yearRangeEnd}`
    : String(signature.year);
}

/**
 * Fields a counterfeit marker ("FAKE") may appear in. Counterfeits are matched
 * like any other coin; the authenticity veto keeps fakes and genuine coins apart.
 *
 * `securityName` isn't on CoinRecord but is carried by Quicken-imported
 * records and is often the only place the word appears.
 *
 * `notes` is excluded: it holds transaction memos about other coins, e.g.
 * "Sent 1860 PCI PF 3CS to a dealer (exchange for 1861 3CS FAKE)" on a
 * genuine coin.
 */
const COUNTERFEIT_RECORD_FIELDS = [
  'coinType', 'variety', 'denomination', 'category', 'coinSet', 'grade', 'securityName'
] as const;

/**
 * Does this inventory record describe a counterfeit? Whole-word,
 * case-insensitive match of COUNTERFEIT_MARKER_WORDS over the identity fields,
 * the same words the filename side uses.
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
 * Parse each coin once for this batch. Counterfeits are kept; their signature
 * carries a `counterfeit` flag for the authenticity veto.
 *
 * @param labels the id -> Label snapshot, taken once for the whole import.
 *   Optional; without it denominations are read from the recorded text.
 */
export function buildCoinSignatures(
  inventory: CoinRecord[],
  labels?: DenominationLabels | null
): CoinSignature[] {
  return inventory
    .map(coin => ({
      coin,
      label: describeCoin(coin),
      signature: parseCoin(coin, labels)
    }));
}

/**
 * Build a signature from a coin record's structured fields. If `denomination`
 * yields nothing, the denomination is looked for inside the type text
 * ("Mercury Dime").
 *
 * @param labels optional id -> Label snapshot; when the coin is linked, the
 *   denomination readers use the label instead of the recorded text.
 */
export function parseCoin(coin: CoinRecord, labels?: DenominationLabels | null): Signature {
  // -- year (supports "1881", "1916-1945", "c. 1881") --------------------
  const yearMatches = [...String(coin.year ?? '').matchAll(/\d{4}/g)].map(m => Number(m[0]));
  const validYears = yearMatches.filter(y => isPlausibleYear(y));
  const year = validYears.length ? validYears[0] : null;
  const yearRangeEnd = validYears.length > 1 ? validYears[validYears.length - 1] : null;

  /* -- denomination ------------------------------------------------------
   * The whole-field reader runs first: `findDenomination` would read the
   * "cent" in "50 Cents" as a one-cent piece. The anchored reader declines
   * anything it doesn't fully parse, so "Three Cent" or "3CS" still fall
   * through to the word table. (Safe on a record field only, not a filename.)
   *
   * The readers get the linked label when there is one (`denominationTextOf`).
   * `denomTokens` still comes from the recorded text because that wording
   * ("Pillar Dollar") is what filenames actually carry. */
  const denomTokens = tokenize(coin.denomination ?? '');
  const denominationText = denominationTextOf(coin, labels);
  const readerTokens =
    denominationText === (coin.denomination ?? '') ? denomTokens : tokenize(denominationText);

  let denomination: { key: string; label: string } | null =
    readTrustedDenominationText(denominationText);

  if (!denomination) {
    denomination = findDenomination(readerTokens);
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

  /* Resolve which Eagle series using the same year rule as the filename side
   * ("Gold Eagle" 2015 = $50 bullion, "Eagle" 1907 = classic $10).
   * Must run after the token removal above, which needs the key the words
   * produced. Searches the recorded text, not the label, because only the
   * recorded text can carry a bullion weight like "1/4 oz". */
  denomination = resolveEagleSeries(
    denomination,
    year,
    [coin.denomination, typeText].filter(Boolean).join(' ')
  );

  // Fold catalogue references ("Sear 6819" -> "sear6819") as the filename side does.
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
    // Display only. Falls back to the authoritative text so an unreadable
    // denomination is still named the way the rest of the app names it.
    denominationLabel: denomination?.label ?? (denominationText || null),
    coinTypeTokens,
    // Normalized so "MS-63", "MS 63" and "ms63" compare equal.
    grade: normalizeGrade(coin.grade),
    certNumbers: certNumber ? [certNumber] : [],
    certCompanies: certCompany ? [certCompany] : [],
    tokens: [...typeTokens, ...denomTokens],

    // Grade decides when present; otherwise the descriptive text, including
    // notes (often the only descriptor on an ungraded record).
    strike: detectStrike(
      [coin.coinType, coin.variety, coin.notes].filter(Boolean).join(' '),
      coin.grade
    ),

    // Fake or genuine, from the identity fields only (never `notes`).
    counterfeit: isCounterfeitRecord(coin)
  };
}
