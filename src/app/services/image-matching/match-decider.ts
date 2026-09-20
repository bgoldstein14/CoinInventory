/* ===========================================================================
 * match-decider.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 3: the DECISION for one image. `matchOneImage` ranks every coin,
 *   applies the three auto-assign safety gates, and returns one of the three
 *   result shapes ('auto' / 'review' / 'none'). `explainWhyNotAuto` writes the
 *   sentence telling the user which gate stopped an auto-match.
 *
 * WHY IT IS ITS OWN FILE
 *   This is the file that embodies the product owner's rule:
 *
 *     "Silently filing an image under the wrong coin is much worse than
 *      asking."
 *
 *   Everything upstream just measures; this is the only place that COMMITS.
 *   Isolating it means the safety gates are impossible to weaken by accident
 *   while editing parsing or scoring, and anyone reviewing a change to the
 *   matcher's caution only has to read these ~100 lines carefully.
 *
 *   The gates are deliberately conservative and all three must pass together.
 * =========================================================================== */

import { ImageMatchResult, RankedImageMatch } from '../../types/coin.model';
import { CoinSignature } from './coin-signature';
import { parseFilename, toSignature } from './filename-parser';
import { scorePair } from './match-scorer';
import {
  AUTO_MARGIN_THRESHOLD,
  AUTO_SCORE_THRESHOLD,
  CANDIDATE_MIN_SCORE,
  MAX_CANDIDATES,
  MIN_STRONG_ATTRIBUTES,
  REVIEW_SCORE_THRESHOLD
} from './matching-thresholds';
import { round } from './text-tokens';

export function matchOneImage(imagePath: string, coinSignatures: CoinSignature[]): ImageMatchResult {
  const parsed = parseFilename(imagePath);

  // Nothing usable in the name (e.g. "IMG_2024.jpg"): do not even rank.
  // Ranking here would just surface noise and tempt the user to accept it.
  if (parsed.isEmpty || coinSignatures.length === 0) {
    return {
      imagePath,
      status: 'none',
      matchedRecordId: null,
      confidence: 0,
      reason: parsed.isEmpty
        ? 'No inventory record matched the image filename: no coin attributes could be read from it.'
        : 'No inventory record matched the image filename: the inventory is empty.',
      candidates: [],
      parsed,
      runnerUpGap: 0
    };
  }

  const fileSignature = toSignature(parsed);

  // Score every coin, then sort best-first. Ties are broken by coin id so the
  // ordering is deterministic (defect #7: the old code let array order decide).
  const scored = coinSignatures
    .map(entry => {
      const breakdown = scorePair(fileSignature, entry.signature);
      const candidate: RankedImageMatch = {
        coinId: entry.coin.id,
        coinLabel: entry.label,
        score: round(breakdown.score),
        reason: breakdown.reason,
        strongAttributeCount: breakdown.strongAttributeCount
      };
      return candidate;
    })
    .sort((a, b) => (b.score - a.score) || a.coinId.localeCompare(b.coinId));

  const best = scored[0];
  const runnerUp = scored[1];
  const runnerUpScore = runnerUp ? runnerUp.score : 0;
  const gap = round(best.score - runnerUpScore);

  const candidates = scored
    .filter(c => c.score >= CANDIDATE_MIN_SCORE)
    .slice(0, MAX_CANDIDATES);

  // ---- the three auto-assign gates -------------------------------------
  const clearsScore = best.score >= AUTO_SCORE_THRESHOLD;
  const hasCorroboration = best.strongAttributeCount >= MIN_STRONG_ATTRIBUTES;
  const clearsRunnerUp = gap >= AUTO_MARGIN_THRESHOLD;

  if (clearsScore && hasCorroboration && clearsRunnerUp) {
    return {
      imagePath,
      status: 'auto',
      matchedRecordId: best.coinId,
      confidence: best.score,
      reason: `Auto-matched to ${best.coinLabel}. ${best.reason} Score ${best.score.toFixed(2)}, next best ${runnerUpScore.toFixed(2)}.`,
      candidates,
      parsed,
      runnerUpGap: gap
    };
  }

  if (best.score >= REVIEW_SCORE_THRESHOLD) {
    return {
      imagePath,
      status: 'review',
      matchedRecordId: null, // deliberately null: nothing is attached without a decision
      confidence: best.score,
      reason: `Needs review. ${best.reason} ${explainWhyNotAuto(best.score, best.strongAttributeCount, gap, runnerUp)}`,
      candidates,
      parsed,
      runnerUpGap: gap
    };
  }

  return {
    imagePath,
    status: 'none',
    matchedRecordId: null,
    confidence: best.score,
    reason: `No inventory record matched the image filename. Best guess ${best.coinLabel} only scored ${best.score.toFixed(2)}.`,
    candidates,
    parsed,
    runnerUpGap: gap
  };
}

/** Human-readable explanation of which safety gate stopped an auto-match. */
export function explainWhyNotAuto(
  score: number,
  strongAttributes: number,
  gap: number,
  runnerUp: RankedImageMatch | undefined
): string {
  const blockers: string[] = [];

  if (score < AUTO_SCORE_THRESHOLD) {
    blockers.push(`score ${score.toFixed(2)} is below the ${AUTO_SCORE_THRESHOLD} auto-match threshold`);
  }
  if (strongAttributes < MIN_STRONG_ATTRIBUTES) {
    blockers.push(
      strongAttributes === 0
        ? 'no attribute agreed outright'
        : 'only one attribute agreed, and one attribute is never enough on its own'
    );
  }
  if (gap < AUTO_MARGIN_THRESHOLD && runnerUp) {
    blockers.push(`${runnerUp.coinLabel} scored ${runnerUp.score.toFixed(2)}, too close to call`);
  }

  return blockers.length ? `Not auto-matched because ${blockers.join('; ')}.` : '';
}
