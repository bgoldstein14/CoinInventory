/*
 * encode-budget.ts — "no photo stored in the database may exceed N bytes".
 *
 * WHAT THE BUDGET MEASURES, AND WHAT IT DOES NOT
 *
 * It measures the COPY THIS APP KEEPS — the downscaled JPEG that goes into
 * `CoinImages.ImageData`. It is NOT a limit on the file the user picks: the
 * originals on the share run to 46 MB and refusing them would reject photos
 * the app has always imported happily. The user's own files are never read
 * for size, never rejected for size and never modified.
 *
 * WHY A LADDER AND NOT ARITHMETIC
 *
 * There is no formula from "I want ≤ 400 KB" to a JPEG quality: the size of a
 * JPEG depends on the picture. So the only honest method is to encode, look
 * at the result, and try again smaller if it did not fit. The ladder below is
 * the order those attempts are made in.
 *
 * *** RUNG 0 IS TODAY'S BEHAVIOUR, AND MUST STAY FIRST. ***
 * 1600 px / quality 0.85 is what every photo in the owner's database was
 * imported at (see image-downscaler.ts for the reasoning behind those two
 * numbers). It is tried first and accepted whenever it fits, so at the
 * default budget the import produces byte-for-byte what it produced before
 * this setting existed. The budget can only ever make a photo SMALLER than
 * that; raising it above the default changes nothing at all, which is what
 * the Settings screen says.
 *
 * WHEN NOTHING FITS
 *
 * The smallest rung is kept rather than the photo being dropped. A budget set
 * low enough to defeat a 640 px thumbnail is a setting mistake, and losing
 * the photograph over it would be far worse than storing one that is 20 KB
 * over. The result reports what actually happened so the caller can say so.
 */

import type { DownscaleResult } from './image-downscaler';

/** One attempt: a long-edge cap and a JPEG quality. */
export interface EncodeAttempt {
  maxEdge: number;
  quality: number;
}

/**
 * The attempts, in order, largest first.
 *
 * Quality is given up before pixels down to 0.75 (below that JPEG blocking
 * starts showing in the flat fields of a coin, which is exactly where a
 * collector looks), and after that both come down together.
 */
export const ENCODE_LADDER: readonly EncodeAttempt[] = [
  { maxEdge: 1600, quality: 0.85 }, // today's behaviour — do not move
  { maxEdge: 1600, quality: 0.75 },
  { maxEdge: 1280, quality: 0.75 },
  { maxEdge: 1024, quality: 0.7 },
  { maxEdge: 800, quality: 0.68 },
  { maxEdge: 640, quality: 0.65 }
];

/** The outcome of fitting one photo into the budget. */
export interface BudgetedEncode {
  /** The encode that was kept. */
  result: DownscaleResult;
  /** Which rung produced it. 0 means "today's behaviour, unchanged". */
  attempt: EncodeAttempt;
  /** How many encodes were performed (1 when the first rung fitted). */
  attempts: number;
  /** True when even the smallest rung was over budget and was kept anyway. */
  overBudget: boolean;
}

/**
 * Encode down the ladder until the result fits the budget.
 *
 * @param maxStoredBytes the budget, in bytes. A non-positive or non-finite
 *        budget means "no byte limit", which stops after the first rung —
 *        i.e. exactly the behaviour this app had before the setting existed.
 * @param encodeAt the thing that actually produces bytes. Injected so this
 *        function is pure arithmetic over results and can be tested in Node,
 *        where there is no <canvas> at all.
 */
export async function encodeWithinBudget(
  maxStoredBytes: number,
  encodeAt: (attempt: EncodeAttempt) => Promise<DownscaleResult>
): Promise<BudgetedEncode> {
  const unlimited = !Number.isFinite(maxStoredBytes) || maxStoredBytes <= 0;

  let last: BudgetedEncode | null = null;

  for (let i = 0; i < ENCODE_LADDER.length; i++) {
    const attempt = ENCODE_LADDER[i]!;
    const result = await encodeAt(attempt);
    last = { result, attempt, attempts: i + 1, overBudget: false };

    if (unlimited || result.storedBytes <= maxStoredBytes) return last;

    /* A photo that was ALREADY small enough not to be resized cannot be made
     * smaller by capping the long edge again, and dropping the quality of a
     * small picture buys little. One more rung is tried (the quality step),
     * and then we stop rather than grinding through four pointless encodes
     * of the same tiny image. */
    if (!result.resized && i >= 1) break;
  }

  // Unreachable in practice: the ladder is never empty, so `last` is set.
  if (!last) throw new Error('Encode ladder produced no attempt');

  return { ...last, overBudget: last.result.storedBytes > maxStoredBytes };
}
