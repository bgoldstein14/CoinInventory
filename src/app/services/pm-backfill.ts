/* ===========================================================================
 * pm-backfill.ts — THE ONE-TIME "FILL IN THE MISSING METAL DATA" PASS
 * ---------------------------------------------------------------------------
 * WHAT PROBLEM THIS SOLVES
 *
 * The app can work out what a coin is made of from its country, denomination
 * and year (see pm-reference.ts). Until now it only ever DID that while
 * importing from Quicken. Every coin that was already in the owner's database
 * when that feature shipped still has its four alloy fields empty — and since
 * melt value is computed from `pmWeightGrams` + `metalContent`, every one of
 * those coins shows a blank melt figure. The only fix was to type the numbers
 * in by hand, one coin at a time.
 *
 * This file is the fix: walk the inventory, run the SAME inference the import
 * runs, and write what is missing.
 *
 * ---------------------------------------------------------------------------
 * IT IS DELIBERATELY TIMID, AND THAT IS THE FEATURE
 * ---------------------------------------------------------------------------
 * Three refusals, each enforced somewhere you can point at:
 *
 *   1. It never overwrites. A field that already holds a value is not even
 *      included in the payload. (`pmFieldsToFill`, in pm-fill.ts.)
 *   2. It never guesses. Where pm-reference.ts declines to say what a coin is
 *      made of — the 1942 nickel, the 1982 cent, the 1971-78 Eisenhower dollar
 *      — this leaves the coin completely alone. No new rules are added here.
 *      (Also `pmFieldsToFill`; this file only counts the refusals.)
 *
 *      Since the coarse metal fallback was added (metal-inference.ts), a coin
 *      the TABLE cannot place may still gain its Metal Content alone — "a US
 *      $20 is gold" — while Composition, PM % and PM weight stay blank. That
 *      is not a weakening of this rule: those three really are unknown, and
 *      leaving them blank is the whole point. The three ambiguous dates above
 *      are refused by the fallback too, for the same reason.
 *   3. It never sends anything but the four alloy fields. (`onlyPmFields`
 *      below, which is belt AND braces over rule 1.)
 *
 * The reason for all three is the same one written at the top of
 * pm-reference.ts: a wrong purity silently produces a wrong melt value, and a
 * silent wrong number is worse than a visible blank.
 *
 * ---------------------------------------------------------------------------
 * SPLIT INTO A PLAN AND A RUN, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `planPmBackfill` is pure: it reads coins and returns what WOULD happen,
 * including the exact payload for each coin. `runPmBackfill` then writes
 * precisely that plan and nothing else.
 *
 * That split is what makes the preview honest. The counts the user confirms
 * are not a separate estimate that might disagree with the run — they are
 * literally the same objects the run then sends. A test asserts that the
 * number of writes equals the number of candidates the preview reported.
 * =========================================================================== */

import { CoinRecord } from '../types/coin.model';
import { PM_FIELD_KEYS, hasAllPmFields, pmFieldsToFill } from './pm-fill';

/** One coin the backfill intends to write, and exactly what it will send. */
export interface PmBackfillCandidate {
  coinId: string;
  /** Short human label for progress and error lines, e.g. "1881-S Morgan $1". */
  label: string;
  /** ONLY alloy fields, and only ones that are currently blank. Never empty. */
  updates: Partial<CoinRecord>;
  /** Which of the four this coin will gain — shown in the preview detail. */
  fields: string[];
}

/**
 * What a backfill would do, worked out before anything is sent.
 *
 * The four counts partition the inventory: every coin lands in exactly one of
 * them, and they sum to `totalScanned`. That is asserted in a test, because a
 * preview whose numbers do not add up is a preview nobody should trust enough
 * to press Run on.
 */
export interface PmBackfillPlan {
  /** Coins looked at — i.e. the whole inventory. */
  totalScanned: number;
  /** The coins that will actually be written, with their payloads. */
  candidates: PmBackfillCandidate[];
  /** `candidates.length`, named so the template reads clearly. */
  fillableCount: number;
  /**
   * Coins where there is nothing for the backfill to add: either all four
   * fields are already filled, or everything the reference table knows about
   * the coin is already recorded (a bronze cent that already says "Bronze"
   * has no PM weight to gain, because it has none).
   */
  alreadyCompleteCount: number;
  /**
   * Coins the reference table will not commit to. Either it deliberately
   * declines (two alloys circulated with that date and denomination), or it
   * simply has no entry for that country/denomination, or the record has no
   * year to work from. All three mean the same thing here: leave it alone.
   */
  undeterminedCount: number;
  /**
   * Rows that exist only on screen and have never been written to the
   * database. There is no server row to PATCH, so a PUT would 404. They are
   * excluded rather than failed — see the note on `isDraft` below.
   */
  skippedDraftCount: number;
}

/** What actually happened once the plan was run. */
export interface PmBackfillOutcome {
  /** How many coins we tried to write. Equals the plan's `fillableCount`. */
  attempted: number;
  /** How many were saved successfully. */
  filled: number;
  /** How many failed. `filled + failed === attempted`, always. */
  failed: number;
  /** One entry per failure, so the user sees which coins to retry. */
  failures: { coinId: string; label: string; reason: string }[];
  /** Total number of individual fields written across all successful coins. */
  fieldsWritten: number;
}

/** Live progress while the plan is being written, for the progress line. */
export interface PmBackfillProgress {
  /** Coins in the plan. */
  total: number;
  /** Coins finished — written OR failed. */
  processed: number;
  /** The coin being written right now. */
  currentLabel: string;
}

/**
 * A short, recognisable name for a coin, for progress lines and error
 * messages. Falls back to the id so a sparse record is still identifiable.
 */
export function describeCoinForBackfill(coin: CoinRecord): string {
  const label = [coin.year, coin.mintMark, coin.coinType, coin.denomination]
    .map((part) => (part ?? '').toString().trim())
    .filter(Boolean)
    .join(' ');
  return label || `coin ${coin.id}`;
}

/**
 * Strip a payload down to the four alloy fields.
 *
 * This is pure paranoia and it is justified paranoia. This project has a
 * history of whole-record writes blanking out columns the user never touched,
 * and `PUT /api/coins/:id` applies whatever it is given. `pmFieldsToFill`
 * already only ever produces alloy keys, so in practice this removes nothing
 * — but it means that even if some future change makes that function sloppy,
 * the worst case is a missing fill rather than a wiped column.
 *
 * Exported so the test that asserts "the payload contains ONLY PM fields" can
 * name the same list this code enforces.
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
 * Work out what a backfill would do, WITHOUT doing any of it.
 *
 * @param coins The current inventory, exactly as the user sees it.
 * @param isDraft Tells us whether a row has ever reached the database.
 *   Passed in rather than imported so this stays a pure function with no
 *   dependency on InventoryService — which is what lets the tests build a plan
 *   from a plain array of objects. Defaults to "everything is saved", which is
 *   the right assumption when no registry is available.
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
    // Unsaved rows first: there is no server row to update, so this is not a
    // judgement about the coin's metal at all. Once the user finishes typing
    // the row it saves itself, and a later backfill will pick it up.
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

    /* -------------------------------------------------------------------
     * Nothing to write, and the coin was NOT already complete. Two very
     * different situations, and the user deserves to be able to tell them
     * apart, so they are counted separately:
     *
     *   UNDETERMINED  the reference table would not say what this coin is
     *                 made of. This is the bucket the 1942 nickel and the
     *                 1982 cent land in, and it is the number that should
     *                 make the owner nod rather than worry.
     *
     *   ALREADY DONE  the table DID answer, but everything it knows is
     *                 already in the record. The commonest case by far is a
     *                 base-metal coin: a 1983 cent that already says "Zinc"
     *                 and "Copper-plated zinc" is missing PM % and PM weight
     *                 only because it HAS no precious metal. Nothing is
     *                 wrong with that coin and it must not be reported as a
     *                 failure to determine anything.
     *
     * Re-running the inference here (rather than threading a reason out of
     * `pmFieldsToFill`) keeps that function's contract to a single job.
     * ----------------------------------------------------------------- */
    // NOTE: `pmFieldsToFill` reads the coin's Coin Type and Composition as
    // well, so "knows this coin" now means "the reference table OR the coarse
    // metal inference would say something" -- which is the right question,
    // because either one is enough to put a value in front of the user.
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
 * All four alloy fields set to `undefined`, used above to ask the reference
 * table "forget what this coin already says — do you know it at all?".
 *
 * Note this clears `metalContent` too, so the question is asked WITHOUT the
 * hint. That is the honest version of the question: if a coin is only
 * determinable because the owner already told us its metal, and all four
 * fields are nonetheless unfillable, there was nothing left to learn anyway.
 */
function blankPmFields(): Partial<CoinRecord> {
  const blanks: Record<string, undefined> = {};
  for (const key of PM_FIELD_KEYS) blanks[key] = undefined;
  return blanks as Partial<CoinRecord>;
}

/**
 * Write a plan, one coin at a time.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LOOP IS SEQUENTIAL AND AWAITS EVERY WRITE
 * ---------------------------------------------------------------------------
 * The obvious implementation — call `InventoryService.updateCoin()` for each
 * coin in a `for` loop — is wrong here, and the reason is worth spelling out
 * because it is not visible from the call site.
 *
 * `CoinEditor.updateCoin()` does not write. It schedules a write one second
 * later, and the timer is kept in a Map keyed by COIN ID (see
 * CoinChangeTracker.schedulePendingWrite), so the debounce is PER COIN, not
 * global. Nothing would be coalesced and nothing would be lost — but all
 * several hundred timers would be set within the same tick and would therefore
 * all fire within the same millisecond, one second later, launching several
 * hundred PUTs in parallel at a SQL Server over a corporate network, with no
 * way to report progress and no way to tell which ones failed.
 *
 * So the backfill uses a different door: `write` below is wired to
 * `InventoryService.updateCoinNow()`, which performs the identical minimal-diff
 * PUT immediately and returns a promise. Awaiting it inside this loop gives
 * three guarantees that matter:
 *
 *   * EXACTLY ONE write per coin — the request is issued here and nowhere
 *     else, with no timer that could fire a second copy;
 *   * AT MOST ONE request in flight at a time — no stampede; and
 *   * an honest progress count and a per-coin failure list, because each
 *     write's outcome is known before the next one starts.
 *
 * A failed coin does NOT stop the run. A backfill that gives up halfway
 * because one row was locked would be worse than one that reports "397 of 400,
 * here are the 3 that failed".
 *
 * @param plan Output of `planPmBackfill`. Only `plan.candidates` is written.
 * @param write Performs one minimal-diff update and resolves when the server
 *   has accepted it. Must reject on failure.
 * @param onProgress Called before each coin, so the UI can show a live count.
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

    // Re-filtered immediately before sending. The plan already did this; doing
    // it again at the only point a request is actually issued means no future
    // change to the planning code can smuggle an extra column into a PUT.
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
