/*
 * In-use counts and removal prompts for the reference-data screen.
 *
 * Counts come from the server (GET /api/reference-usage), where the removal
 * UPDATE runs, so the number shown is the number of coins the delete touches.
 * Removing a denomination soft-deletes it and clears linked coins'
 * DenominationId; their denomination text is kept.
 *
 * The unresolved display string must come from `denominationDisplay()`;
 * denomination-display.spec.ts fails if any other file builds it.
 */

import { denominationDisplay } from '../../services/denominations/denomination-display';
import { ReferenceUsageCounts, UsageIndex } from '../../types/reference-data.model';

// Re-exported for convenience; declared in types/ because ApiService uses them too.
export type { ReferenceUsageCounts, UsageIndex };

/** Counts before the server answers: empty indexes, so lookups return 0. */
export const EMPTY_REFERENCE_USAGE: ReferenceUsageCounts = {
  categories: {},
  coinSets: {},
  denominations: {},
  mintMarks: {},
  catalogs: {},
  metalContents: {},
};

/** One `SELECT key, COUNT(*)` row, as loosely typed as JSON leaves it. */
export interface UsageRow {
  key: unknown;
  count: unknown;
}

/**
 * Turn count rows into a lookup. Keys are stringified so a number id and its
 * string form find the same count. Rows with no usable key are dropped.
 */
export function buildUsageIndex(rows: readonly UsageRow[]): UsageIndex {
  const index: UsageIndex = {};
  for (const row of rows) {
    if (row.key === null || row.key === undefined) continue;
    const key = String(row.key);
    if (key.length === 0) continue;
    const count = Number(row.count);
    index[key] = Number.isFinite(count) ? count : 0;
  }
  return index;
}

/** Read a count out of an index; 0 for anything missing. */
export function usageCount(
  index: UsageIndex | undefined | null,
  key: string | number | null | undefined
): number {
  if (!index || key === null || key === undefined) return 0;
  const value = index[String(key)];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Clamp a count to a whole, non-negative number. */
function sane(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** "3 coins" / "1 coin". */
function coinsPhrase(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/** The in-use badge beside every entry, in words. */
export function describeUsage(count: number): string {
  const safe = sane(count);
  if (safe === 0) return 'Not used by any coin';
  return `Used by ${coinsPhrase(safe)}`;
}

export interface DenominationRemovalPlan {
  denominationId: number;
  label: string;
  coinCount: number;
  /** What those coins will read afterwards. Built by denominationDisplay(). */
  resultingDisplay: string;
  /** The exact text handed to the confirmation dialog. */
  prompt: string;
}

/** Describe removing a denomination: the coin count first, then what they keep. */
export function planDenominationRemoval(
  denomination: { denominationId: number; label: string },
  coinCount: number
): DenominationRemovalPlan {
  const count = sane(coinCount);
  const resultingDisplay = denominationDisplay(null, denomination.label);

  const prompt =
    count === 0
      ? `Remove the denomination "${denomination.label}"? No coins use it.`
      : `Remove the denomination "${denomination.label}"?\n\n` +
        `${coinsPhrase(count)} ${count === 1 ? 'uses' : 'use'} it. ` +
        `What ${count === 1 ? 'it says' : 'they say'} is kept, so ` +
        `${count === 1 ? 'it' : 'they'} will read ${resultingDisplay} until you ` +
        `re-select a denomination, which re-links ${count === 1 ? 'it' : 'them'}. ` +
        `Nothing is lost.`;

  return {
    denominationId: denomination.denominationId,
    label: denomination.label,
    coinCount: count,
    resultingDisplay,
    prompt,
  };
}

export interface ReferenceRemovalPlan {
  name: string;
  coinCount: number;
  prompt: string;
}

/**
 * Describe removing anything that is not a denomination. Coins keep their
 * text; only the dropdown entry goes, so there is nothing to re-link.
 *
 * @param kind lower-case singular noun ('category', 'set', 'mint mark', ...),
 *             interpolated as written.
 */
export function planReferenceRemoval(kind: string, name: string, coinCount: number): ReferenceRemovalPlan {
  const count = sane(coinCount);

  const prompt =
    count === 0
      ? `Remove the ${kind} "${name}"? No coins use it.`
      : `Remove the ${kind} "${name}"?\n\n` +
        `${coinsPhrase(count)} ${count === 1 ? 'uses' : 'use'} it. ` +
        `${count === 1 ? 'It keeps' : 'They keep'} the text already recorded; ` +
        `only the entry in this list goes, so it stops being offered in the editor.`;

  return { name, coinCount: count, prompt };
}
