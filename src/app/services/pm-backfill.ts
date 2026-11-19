 /*
  * Settings > Maintenance "fill in missing metal data": runs the same inference
  * as the import over existing coins and writes only what is missing, so older
  * coins get a melt value.
  *
  * - Never overwrites: filled fields aren't in the payload (`pmFieldsToFill`).
  * - Never guesses: coins pm-reference.ts won't place (1942 nickel, 1982 cent,
  *   1971-78 Eisenhower) are left alone. The coarse fallback may add Metal
  *   Content alone ("a US $20 is gold") while the other fields stay blank.
  * - Only alloy fields are sent (`onlyPmFields`).
  *
  * `planPmBackfill` is pure and returns the exact payloads; `runPmBackfill`
  * writes exactly that plan, so the preview counts match the run (a test checks).
  */

import { CoinRecord } from '../types/coin.model';
import { PM_FIELD_KEYS, hasAllPmFields, pmFieldsToFill } from './pm-fill';

/** One coin the backfill intends to write, and exactly what it will send. */
export interface PmBackfillCandidate {
  coinId: string;
  /** Short label for progress and errors, e.g. "1881-S Morgan $1". */
  label: string;
  /** Only alloy fields that are currently blank; never empty. */
  updates: Partial<CoinRecord>;
  /** Which fields this coin will gain (shown in the preview). */
  fields: string[];
}

/**
 * What a backfill would do, before anything is sent. The four counts partition
 * the inventory and sum to `totalScanned` (a test checks).
 */
export interface PmBackfillPlan {
  /** Coins looked at: the whole inventory. */
  totalScanned: number;
  /** The coins that will actually be written, with their payloads. */
  candidates: PmBackfillCandidate[];
  /** `candidates.length`, for the template. */
  fillableCount: number;
  /**
   * Coins with nothing to add: all fields filled, or everything the table knows
   * is already recorded (a bronze cent has no PM weight to gain).
   */
  alreadyCompleteCount: number;
  /**
   * Coins the table won't place: two alloys for that date, no entry, or no year.
   * Left alone.
   */
  undeterminedCount: number;
  /** Rows never written to the database (a PUT would 404); excluded rather than failed. */
  skippedDraftCount: number;
}

/** What actually happened once the plan was run. */
export interface PmBackfillOutcome {
  /** Coins we tried to write; equals the plan's `fillableCount`. */
  attempted: number;
  /** How many were saved successfully. */
  filled: number;
  /** How many failed; `filled + failed === attempted`. */
  failed: number;
  /** One entry per failure, so the user sees which coins to retry. */
  failures: { coinId: string; label: string; reason: string }[];
  /** Total individual fields written across all successful coins. */
  fieldsWritten: number;
}

/** Live progress while the plan is written. */
export interface PmBackfillProgress {
  /** Coins in the plan. */
  total: number;
  /** Coins finished, written or failed. */
  processed: number;
  /** The coin being written right now. */
  currentLabel: string;
}

/** Short name for progress lines and errors; falls back to the id. */
export function describeCoinForBackfill(coin: CoinRecord): string {
  const label = [coin.year, coin.mintMark, coin.coinType, coin.denomination]
    .map((part) => (part ?? '').toString().trim())
    .filter(Boolean)
    .join(' ');
  return label || `coin ${coin.id}`;
}

/**
 * Strips a payload to the alloy fields. `pmFieldsToFill` already does, but
 * `PUT /api/coins/:id` applies whatever it is given, so a future bug here would
 * only lose a fill, never wipe a column. Exported so the payload test uses the
 * same list.
 */
export function onlyPmFields(updates: Partial<CoinRecord>): Partial<CoinRecord> {
  const allowed = new Set<string>(PM_FIELD_KEYS);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (allowed.has(key)) clean[key] = value;
  }
  return clean as Partial<CoinRecord>;
}

/**
 * Works out what a backfill would do, without doing it.
 *
 * @param coins the inventory as the user sees it
 * @param isDraft whether a row has never reached the database; passed in to keep
 *   this pure. Defaults to "everything is saved".
 */
export function planPmBackfill(
  coins: readonly CoinRecord[],
  isDraft: (coinId: string) => boolean = () => false
): PmBackfillPlan {
  const candidates: PmBackfillCandidate[] = [];
  let alreadyCompleteCount = 0;
  let undeterminedCount = 0;
  let skippedDraftCount = 0;

  for (const coin of coins) {
    // Unsaved rows: nothing to update yet; a later backfill picks them up.
    if (isDraft(coin.id)) {
      skippedDraftCount += 1;
      continue;
    }

    // Already has all four. No lookup needed and nothing to report.
    if (hasAllPmFields(coin)) {
      alreadyCompleteCount += 1;
      continue;
    }

    const updates = onlyPmFields(pmFieldsToFill(coin));

    if (Object.keys(updates).length > 0) {
      candidates.push({
        coinId: coin.id,
        label: describeCoinForBackfill(coin),
        updates,
        fields: Object.keys(updates)
      });
      continue;
    }

    /* Nothing to write and not complete. Counted separately:
     *   undetermined  the table won't say what the coin is (1942 nickel, 1982 cent)
     *   already done  the table answered but everything is recorded; usually a
     *                 base-metal coin missing PM fields because it has no PM
     * "Knows this coin" includes the coarse metal fallback, since `pmFieldsToFill`
     * also reads Coin Type and Composition. */
    const tableKnowsThisCoin = Object.keys(pmFieldsToFill({ ...coin, ...blankPmFields() })).length > 0;
    if (tableKnowsThisCoin) {
      alreadyCompleteCount += 1;
    } else {
      undeterminedCount += 1;
    }
  }

  return {
    totalScanned: coins.length,
    candidates,
    fillableCount: candidates.length,
    alreadyCompleteCount,
    undeterminedCount,
    skippedDraftCount
  };
}

/**
 * All alloy fields set to `undefined`, to ask the table whether it knows the coin
 * at all. This also clears `metalContent`, so the question is asked without the hint.
 */
function blankPmFields(): Partial<CoinRecord> {
  const blanks: Record<string, undefined> = {};
  for (const key of PM_FIELD_KEYS) blanks[key] = undefined;
  return blanks as Partial<CoinRecord>;
}

/**
 * Writes a plan one coin at a time, sequentially and awaited.
 *
 * `updateCoin()` schedules a debounced write per coin (CoinChangeTracker), so
 * calling it in a loop would fire hundreds of PUTs in the same millisecond with
 * no progress or failure reporting. `write` is wired to
 * `InventoryService.updateCoinNow()` (the same minimal-diff PUT, immediately):
 * one write per coin, one request in flight, and a known outcome per coin. A
 * failed coin doesn't stop the run.
 *
 * @param plan output of `planPmBackfill`; only `plan.candidates` is written
 * @param write performs one minimal-diff update; must reject on failure
 * @param onProgress called before each coin
 */
export async function runPmBackfill(
  plan: PmBackfillPlan,
  write: (coinId: string, updates: Partial<CoinRecord>) => Promise<void>,
  onProgress?: (progress: PmBackfillProgress) => void
): Promise<PmBackfillOutcome> {
  const total = plan.candidates.length;
  const failures: PmBackfillOutcome['failures'] = [];
  let filled = 0;
  let fieldsWritten = 0;

  for (let index = 0; index < total; index += 1) {
    const candidate = plan.candidates[index];

    onProgress?.({ total, processed: index, currentLabel: candidate.label });

    // Re-filtered at the point of sending, so planning changes can't add columns.
    const payload = onlyPmFields(candidate.updates);

    try {
      await write(candidate.coinId, payload);
      filled += 1;
      fieldsWritten += Object.keys(payload).length;
    } catch (error) {
      failures.push({
        coinId: candidate.coinId,
        label: candidate.label,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  onProgress?.({ total, processed: total, currentLabel: '' });

  return {
    attempted: total,
    filled,
    failed: failures.length,
    failures,
    fieldsWritten
  };
}
