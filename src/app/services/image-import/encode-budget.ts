/*
 * encode-budget.ts — "no photo stored in the database may exceed N bytes".
 *
 * The budget applies to the downscaled JPEG stored in `CoinImages.ImageData`,
 * never to the user's original file.
 *
 * JPEG size depends on the picture, so photos are encoded down a ladder of
 * size/quality settings until one fits. Rung 0 (1600 px / 0.85) is the
 * standard import setting (see image-downscaler.ts) and is always tried first,
 * so the budget can only make a photo smaller. If nothing fits, the smallest
 * rung is kept and reported as over budget rather than dropping the photo.
 */

import type { DownscaleResult } from './image-downscaler';

/** One attempt: a long-edge cap and a JPEG quality. */
export interface EncodeAttempt {
  maxEdge: number;
  quality: number;
}

/**
 * The attempts, in order, largest first. Quality drops first, to 0.75 (below
 * that, JPEG blocking shows in a coin's flat fields); then both come down.
 */
export const ENCODE_LADDER: readonly EncodeAttempt[] = [
  { maxEdge: 1600, quality: 0.85 }, // standard import setting; must stay first
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
  /** Which rung produced it. */
  attempt: EncodeAttempt;
  /** How many encodes were performed (1 when the first rung fitted). */
  attempts: number;
  /** True when even the smallest rung was over budget and was kept anyway. */
  overBudget: boolean;
}

/**
 * Encode down the ladder until the result fits the budget.
 *
 * @param maxStoredBytes the budget, in bytes. Non-positive or non-finite means
 *        no limit (stop after the first rung).
 * @param encodeAt produces the bytes; injected so this is testable without a
 *        <canvas>.
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

    // A photo too small to be resized can't shrink by capping the edge, so
    // stop after the quality step.
    if (!result.resized && i >= 1) break;
  }

  // Unreachable: the ladder is never empty.
  if (!last) throw new Error('Encode ladder produced no attempt');

  return { ...last, overBudget: last.result.storedBytes > maxStoredBytes };
}
