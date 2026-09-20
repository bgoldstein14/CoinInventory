/* ===========================================================================
 * Coin completeness — THE rule for "is this enough to be a coin record?"
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   One question, answered in exactly one place:
 *
 *       "Does this record carry enough detail to live in the database?"
 *
 *   The answer is the 2-OF-3 RULE: at least two of Year / Coin Type /
 *   Denomination must be genuinely populated.
 *
 * WHY IT IS ITS OWN FILE
 *   Two completely different parts of the app need this same answer:
 *
 *     1. The QIF import (`quicken-import.service.ts`) uses it to decide which
 *        parsed rows are real coins and which go on the "exceptions" list.
 *     2. The "Add coin" button (`inventory/coin-draft-registry.ts` and
 *        `inventory/coin-editor.ts`) uses it to decide when a brand-new,
 *        still-being-typed row has become worth POSTing to the server.
 *
 *   It used to live inside the QIF parser. Copying it into the second caller
 *   would have created two rules that start identical and silently drift
 *   apart — which is exactly the class of bug that has bitten this project
 *   before. So it moved here, and BOTH callers import it. The QIF service
 *   re-exports the same symbols so its own (unchanged) tests still work.
 *
 * Everything in here is a pure function. No Angular, no HTTP, no signals.
 * =========================================================================== */

/**
 * The three "main details" a coin must be described by. A QIF security name
 * such as "1921 Morgan Dollar MS63" yields all three (Year = 1921,
 * Coin Type = Morgan, Denomination = $1).
 *
 * `key` is the property name on the record; `label` is what we show the user
 * in an exception message or a draft-row hint.
 */
export const MAIN_COIN_DETAILS = [
  { key: 'year', label: 'Year' },
  { key: 'coinType', label: 'Coin Type' },
  { key: 'denomination', label: 'Denomination' }
] as const;

/**
 * How many of the three main details must be populated before a coin is
 * allowed into the inventory. Two out of three: we can live with one blank,
 * but a coin described by (say) a year alone is not a coin record, it is a
 * fragment -- and the backend rejects it anyway with
 * `400 {"error":"denomination is required"}`.
 */
export const MINIMUM_MAIN_DETAILS = 2;

/**
 * Strings that *look* populated but carry no information. Quicken exports and
 * earlier versions of this parser are both happy to hand us these, and a naive
 * truthiness test (`if (value)`) treats every one of them as "present".
 * Everything here is compared lower-cased and whitespace-collapsed.
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
 * The single source of truth for "does this field actually contain a detail?".
 *
 * Deliberately strict, because every regression in this area came from a
 * looser test:
 *   - `value != null`      -> `''` counts as present
 *   - `if (value)`         -> `' '` and `'0'` count as present
 *   - `value.length > 0`   -> `'   '` counts as present
 */
export function isCoinDetailPresent(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  // Collapse runs of whitespace (including non-breaking spaces from Quicken's
  // windows-1252 exports) so '  ' and ' ' normalize to ''.
  const normalized = value.replace(/[\s ]+/g, ' ').trim().toLowerCase();
  if (normalized === '') return false;
  return !PLACEHOLDER_DETAIL_VALUES.has(normalized);
}

/** The outcome of running the 2-of-3 rule against one record. */
export interface CoinDetailCheck {
  /** Human-readable labels of the main details that are populated. */
  present: string[];
  /** Human-readable labels of the main details that are blank/placeholder. */
  missing: string[];
  /** True when at least `MINIMUM_MAIN_DETAILS` of the three are populated. */
  passes: boolean;
  /** Ready-to-display explanation; empty string when `passes` is true. */
  reason: string;
}

/**
 * The shape both callers can satisfy: a parsed QIF record and a live
 * CoinRecord both happen to have these three optional string fields, so
 * neither side has to convert anything before asking.
 */
export interface MainCoinDetails {
  year?: string;
  coinType?: string;
  denomination?: string;
}

/**
 * Applies the 2-of-3 rule. Pure function, no Angular involved, so it is easy
 * to unit test and impossible to accidentally couple to parse order.
 */
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

/**
 * Convenience wrapper for the many callers that only want a yes/no.
 *
 * Read this as "is this record complete enough to save?". Anything the app
 * would refuse to POST is, by definition, still a draft.
 */
export function hasEnoughCoinDetail(record: MainCoinDetails): boolean {
  return checkMainCoinDetails(record).passes;
}

/**
 * A short, friendly sentence for the UI telling the user what a draft row
 * still needs — e.g.
 *
 *   "Not saved yet. Add 2 of: Year, Coin Type, Denomination."
 *   "Not saved yet. Add 1 more of: Coin Type, Denomination."
 *
 * Kept next to the rule itself so the wording can never describe a different
 * threshold from the one actually enforced.
 */
export function describeMissingCoinDetail(record: MainCoinDetails): string {
  const check = checkMainCoinDetails(record);
  if (check.passes) return '';

  const stillNeeded = MINIMUM_MAIN_DETAILS - check.present.length;
  const noun = check.present.length === 0 ? `${stillNeeded} of` : `${stillNeeded} more of`;
  return `Not saved yet. Add ${noun}: ${check.missing.join(', ')}.`;
}
