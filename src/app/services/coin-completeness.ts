 /*
  * The 2-of-3 rule for "is this enough to be a coin record?": at least two of
  * Year / Coin Type / Denomination must be genuinely populated.
  *
  * Shared by the QIF import (which rows are coins vs exceptions) and the Add
  * coin flow (inventory/coin-draft-registry.ts, inventory/coin-editor.ts: when a
  * new row is ready to POST). quicken-import.service.ts re-exports these symbols.
  * Pure functions.
  */

/**
 * The three main details a coin is described by. "1921 Morgan Dollar MS63"
 * yields all three (Year 1921, Coin Type Morgan, Denomination $1). `label` is
 * shown in exception messages and draft-row hints.
 */
export const MAIN_COIN_DETAILS = [
  { key: 'year', label: 'Year' },
  { key: 'coinType', label: 'Coin Type' },
  { key: 'denomination', label: 'Denomination' }
] as const;

/**
 * Main details required before a coin is saved. A single detail is a fragment,
 * and the backend rejects a coin without a denomination anyway
 * (`400 {"error":"denomination is required"}`).
 */
export const MINIMUM_MAIN_DETAILS = 2;

/**
 * Values that look populated but carry no information (seen in Quicken
 * exports); compared lower-cased and whitespace-collapsed.
 */
const PLACEHOLDER_DETAIL_VALUES = new Set([
  '-',
  '--',
  '---',
  '.',
  '?',
  '0',
  '00',
  '000',
  '0000',
  'n/a',
  'na',
  'n.a.',
  'none',
  'null',
  'nil',
  'undefined',
  'unknown',
  'unk',
  'tbd',
  'misc',
  'other'
]);

/**
 * Whether a field really contains a detail. Stricter than truthiness:
 * '', ' ', '   ', '0' and placeholder values are all absent.
 */
export function isCoinDetailPresent(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  // Collapse whitespace, including non-breaking spaces from windows-1252 Quicken exports.
  const normalized = value.replace(/[\s ]+/g, ' ').trim().toLowerCase();
  if (normalized === '') return false;
  return !PLACEHOLDER_DETAIL_VALUES.has(normalized);
}

/** Result of the 2-of-3 rule for one record. */
export interface CoinDetailCheck {
  /** Human-readable labels of the main details that are populated. */
  present: string[];
  /** Human-readable labels of the main details that are blank/placeholder. */
  missing: string[];
  /** True when at least `MINIMUM_MAIN_DETAILS` of the three are populated. */
  passes: boolean;
  /** Display explanation; '' when `passes` is true. */
  reason: string;
}

/** Fields shared by a parsed QIF record and a CoinRecord, so both can be checked directly. */
export interface MainCoinDetails {
  year?: string;
  coinType?: string;
  denomination?: string;
}

/** Applies the 2-of-3 rule. */
export function checkMainCoinDetails(record: MainCoinDetails): CoinDetailCheck {
  const present: string[] = [];
  const missing: string[] = [];

  for (const detail of MAIN_COIN_DETAILS) {
    if (isCoinDetailPresent(record[detail.key])) {
      present.push(detail.label);
    } else {
      missing.push(detail.label);
    }
  }

  const passes = present.length >= MINIMUM_MAIN_DETAILS;
  const reason = passes
    ? ''
    : `Only ${present.length} of ${MAIN_COIN_DETAILS.length} required details found: ` +
      `${present.length > 0 ? present.join(', ') : 'none'}. ` +
      `Missing: ${missing.join(', ')}.`;

  return { present, missing, passes, reason };
}

/** Yes/no form: is this record complete enough to save? Anything less is still a draft. */
export function hasEnoughCoinDetail(record: MainCoinDetails): boolean {
  return checkMainCoinDetails(record).passes;
}

/**
 * Short UI sentence telling the user what a draft row still needs, e.g.
 *   "Not saved yet. Add 2 of: Year, Coin Type, Denomination."
 *   "Not saved yet. Add 1 more of: Coin Type, Denomination."
 */
export function describeMissingCoinDetail(record: MainCoinDetails): string {
  const check = checkMainCoinDetails(record);
  if (check.passes) return '';

  const stillNeeded = MINIMUM_MAIN_DETAILS - check.present.length;
  const noun = check.present.length === 0 ? `${stillNeeded} of` : `${stillNeeded} more of`;
  return `Not saved yet. Add ${noun}: ${check.missing.join(', ')}.`;
}
