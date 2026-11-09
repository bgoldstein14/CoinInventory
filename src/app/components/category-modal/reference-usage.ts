/*
 * reference-usage.ts — the in-use count, and what Remove actually does.
 *
 * REMOVING A DENOMINATION, END TO END
 *
 *     1. Count the coins using it. Say the number plainly.
 *     2. If confirmed: soft-delete (IsActive = 0) and null those coins'
 *        DenominationId.
 *     3. Coins.Denomination TEXT is NEVER touched.
 *     4. Re-selecting a denomination re-links them. Nothing is lost.
 *
 * Steps 2 and 3 happen in SQL (server/routes/lookups/denominations.ts). This
 * module owns step 1 and the sentence that promises step 4, because that
 * sentence is what makes the confirmation answerable: without it the honest
 * answer to "3 coins use it, continue?" is always no, and the mess stays.
 *
 * WHERE THE NUMBERS COME FROM, AND WHY NOT FROM THE LOADED COINS
 * The browser holds every coin and `CoinRecord` carries `denominationId`, so
 * counting client-side is possible. It is still wrong here, for one reason:
 * THE NUMBER SHOWN MUST BE THE NUMBER THE DELETE TOUCHES. The delete is a
 * server-side `UPDATE Coins SET DenominationId = NULL WHERE DenominationId =
 * @id`. A count derived from a snapshot the browser loaded at startup can
 * disagree with that statement — a coin edited in another tab, an import that
 * ran since, a record whose write failed and left the in-memory copy ahead of
 * the row. Counting in the same place the UPDATE runs makes that class of
 * disagreement impossible rather than unlikely.
 *
 * The other four reference types follow the same source rather than splitting
 * one screen across two sources with different staleness. One endpoint
 * (GET /api/reference-usage), one round trip, one moment.
 *
 * ON THE "those coins will read ..." STRING
 * It is produced by `denominationDisplay()` and never assembled here.
 * services/denominations/denomination-display.spec.ts greps the whole source
 * tree and fails the build if any other file builds that form: a second copy
 * is a FORK rather than a duplicate, and the dialog would promise one
 * spelling while the grid showed another, with nothing failing. That is why a
 * function call stands where a template literal would obviously have done.
 */

import { denominationDisplay } from '../../services/denominations/denomination-display';
import { ReferenceUsageCounts, UsageIndex } from '../../types/reference-data.model';

// Re-exported so a caller working on this screen has one import for the
// counts and the functions that read them. The declarations live in types/
// because ApiService needs them too and must not import from a component.
export type { ReferenceUsageCounts, UsageIndex };

/**
 * What the screen shows before the counts have arrived.
 *
 * A real object with five empty indexes rather than null, so every template
 * read is `usageCount(...)` returning 0 instead of a null check the next
 * pane will forget.
 */
export const EMPTY_REFERENCE_USAGE: ReferenceUsageCounts = {
  categories: {},
  coinSets: {},
  denominations: {},
  mintMarks: {},
  catalogs: {},
};

/** One `SELECT key, COUNT(*)` row, as loosely typed as JSON leaves it. */
export interface UsageRow {
  key: unknown;
  count: unknown;
}

/**
 * Turn count rows into a lookup.
 *
 * *** KEYS ARE STRINGIFIED, AND THAT IS THE POINT. ***
 * A count keyed by the number 103 and looked up with the string '103' reads
 * as 0, and the screen then offers to delete a denomination three coins are
 * using while promising that none are. JSON, template interpolation and
 * `Object.keys` all produce strings at some point in the round trip, so
 * everything is normalised to a string on the way in and on the way out.
 *
 * A row with no usable key is dropped rather than bucketed under 'null' or
 * 'undefined' — an invented bucket would show up as a phantom entry nobody
 * can match to a row.
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

/**
 * Read a count out of an index.
 *
 * Zero for anything missing, never undefined: an undefined reaching the
 * template renders as a blank where a number belongs, and a blank reads as
 * "unknown" on the one screen whose job is to make the consequence known.
 */
export function usageCount(
  index: UsageIndex | undefined | null,
  key: string | number | null | undefined
): number {
  if (!index || key === null || key === undefined) return 0;
  const value = index[String(key)];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Clamp a count to a whole, non-negative number before it is spoken aloud. */
function sane(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/** "3 coins" / "1 coin" — the plural, got right once. */
function coinsPhrase(count: number): string {
  return count === 1 ? '1 coin' : `${count} coins`;
}

/**
 * The badge beside every entry on every pane.
 *
 * Plain words rather than a bare number, because "0" next to "Gold" is
 * ambiguous — zero what? — and this badge is the only warning the user gets
 * before pressing Remove.
 */
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

/**
 * Describe removing a denomination.
 *
 * The prompt names the number first and the reassurance second, in that
 * order, because the user is answering a question about risk: hearing
 * "nothing is lost" before hearing "three coins" reads as a sales pitch.
 */
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
 * Describe removing anything that is NOT a denomination.
 *
 * Deliberately a different sentence. Removing a category or a set takes an
 * entry out of a dropdown; the coins keep the text they already hold,
 * because that text is a column on the coin and nothing here writes to it.
 * There is no id to null and nothing to re-link, so borrowing the
 * denomination wording would promise a recovery step that does not exist.
 *
 * @param kind lower-case singular noun — 'category', 'set', 'mint mark',
 *             'catalogue', 'issuer'. It is interpolated as written.
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
