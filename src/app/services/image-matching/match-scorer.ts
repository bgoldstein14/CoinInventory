/* ===========================================================================
 * match-scorer.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 2: comparing ONE filename signature against ONE coin signature and
 *   producing a 0..1 score, a count of strong agreements, and a plain-English
 *   reason. `scorePair` is the whole of it; `buildReason`, `diceSimilarity`
 *   and `formatYear` are its private helpers.
 *
 * WHY IT IS ITS OWN FILE
 *   Scoring answers "how alike are these two?" and nothing else. It has no
 *   opinion about whether that is good enough to act on -- that judgement is
 *   match-decider.ts's job. Keeping the measurement separate from the
 *   decision means you can change how alike-ness is measured without
 *   accidentally loosening a safety gate, and vice versa.
 *
 *   It is also the file where the "absence is not agreement" rule is
 *   enforced, which is the single most important invariant in the matcher:
 *   an attribute that only one side has must stay out of BOTH the numerator
 *   and the denominator. Every `if (both sides have it)` guard below is that
 *   rule.
 * =========================================================================== */

import { Signature } from './coin-signature';
import {
  COIN_TYPE_STRONG_SIMILARITY,
  DAMPING_FLOOR,
  DAMPING_RANGE,
  TOTAL_WEIGHT,
  WEIGHTS
} from './matching-thresholds';
import { mintLabel } from './reference-tables';
import { capitalize, titleCase } from './text-tokens';

/** Outcome of comparing one filename signature against one coin signature. */
export interface ScoreBreakdown {
  score: number;
  strongAttributeCount: number;
  reason: string;
}

/**
 * Compare one filename signature to one coin signature.
 *
 * The core idea, stated plainly:
 *
 *   score = (how much of the comparable evidence agreed)
 *         x (how much evidence was comparable at all)
 *
 * An attribute is "comparable" only when BOTH sides have a value for it.
 * If the coin record has no mint mark, the coin's silence is not evidence
 * for or against -- the attribute is simply left out of both the numerator
 * and the denominator. This is the "absence must not count as agreement"
 * rule, and it is why a sparsely-filled coin record cannot rack up a fake
 * perfect score.
 */
export function scorePair(file: Signature, coin: Signature): ScoreBreakdown {
  let achieved = 0;      // weighted agreement actually observed
  let comparable = 0;    // weighted evidence that could be compared
  let strongAttributes = 0;
  const agreed: string[] = [];
  const disagreed: string[] = [];

  // ---- Year ------------------------------------------------------------
  if (file.year !== null && coin.year !== null) {
    comparable += WEIGHTS.year;
    // Coin records may hold a range ("1916-1945" for a type set entry).
    const end = coin.yearRangeEnd ?? coin.year;
    const inRange = file.year >= coin.year && file.year <= end;
    if (inRange) {
      achieved += WEIGHTS.year;
      strongAttributes++;
      agreed.push(`year ${file.year} matches`);
    } else {
      disagreed.push(`year ${file.year} does not match the record's ${formatYear(coin)}`);
    }
  }

  // ---- Denomination ----------------------------------------------------
  if (file.denomination && coin.denomination) {
    comparable += WEIGHTS.denomination;
    if (file.denomination === coin.denomination) {
      achieved += WEIGHTS.denomination;
      strongAttributes++;
      agreed.push(`denomination ${file.denominationLabel ?? file.denomination} matches`);
    } else {
      disagreed.push(
        `denomination ${file.denominationLabel ?? file.denomination} does not match ${coin.denominationLabel ?? coin.denomination}`
      );
    }
  }

  // ---- Coin type (design name: Morgan, Peace, Walking Liberty, ...) -----
  if (file.coinTypeTokens.length > 0 && coin.coinTypeTokens.length > 0) {
    comparable += WEIGHTS.coinType;
    const similarity = diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens);
    achieved += WEIGHTS.coinType * similarity;
    const shared = file.coinTypeTokens.filter(t => coin.coinTypeTokens.includes(t));
    if (similarity >= COIN_TYPE_STRONG_SIMILARITY) {
      strongAttributes++;
      agreed.push(`coin type ${titleCase(shared.join(' '))} matches`);
    } else if (shared.length > 0) {
      agreed.push(`coin type partially matches on ${titleCase(shared.join(' '))}`);
    } else {
      disagreed.push(
        `coin type "${titleCase(file.coinTypeTokens.join(' '))}" does not match "${titleCase(coin.coinTypeTokens.join(' '))}"`
      );
    }
  }

  // ---- Certification number (near-proof when present on both sides) -----
  if (file.certNumbers.length > 0 && coin.certNumbers.length > 0) {
    comparable += WEIGHTS.certNumber;
    const hit = file.certNumbers.find(n => coin.certNumbers.includes(n));
    if (hit) {
      achieved += WEIGHTS.certNumber;
      strongAttributes++;
      agreed.push(`certification number ${hit} matches`);
    } else {
      disagreed.push('certification number does not match');
    }
  }

  // ---- Mint mark -------------------------------------------------------
  if (file.mintMark && coin.mintMark) {
    comparable += WEIGHTS.mintMark;
    if (file.mintMark === coin.mintMark) {
      achieved += WEIGHTS.mintMark;
      strongAttributes++;
      agreed.push(`mint mark ${mintLabel(file.mintMark)} matches`);
    } else {
      disagreed.push(`mint mark ${mintLabel(file.mintMark)} differs from ${mintLabel(coin.mintMark)}`);
    }
  }

  // Nothing at all was comparable -> no evidence -> zero. Never a match.
  if (comparable === 0) {
    return {
      score: 0,
      strongAttributeCount: 0,
      reason: 'Nothing in the filename could be compared against this record.'
    };
  }

  const normalized = achieved / comparable;               // 0..1, "did it agree?"
  const coverage = comparable / TOTAL_WEIGHT;             // 0..1, "how much could we check?"
  const damping = DAMPING_FLOOR + DAMPING_RANGE * coverage;
  const score = Math.max(0, Math.min(1, normalized * damping));

  return {
    score,
    strongAttributeCount: strongAttributes,
    reason: buildReason(agreed, disagreed)
  };
}

/** Turn the agreement lists into one specific, honest sentence. */
export function buildReason(agreed: string[], disagreed: string[]): string {
  const parts: string[] = [];
  if (agreed.length) parts.push(capitalize(agreed.join('; ')) + '.');
  if (disagreed.length) parts.push(capitalize(disagreed.join('; ')) + '.');
  if (!parts.length) return 'No attributes in common.';
  return parts.join(' ');
}

/**
 * Dice coefficient: 2 * shared / (sizeA + sizeB).
 *
 * Symmetric, so "morgan" vs "morgan" = 1.0 but "morgan" vs
 * "morgan liberty head" = 0.5. That penalty is intentional -- a filename
 * mentioning only part of a coin's design name is weaker evidence.
 */
export function diceSimilarity(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Render a coin's year (or year range) for the explanation text. */
export function formatYear(coin: Signature): string {
  if (coin.year === null) return 'unknown year';
  return coin.yearRangeEnd && coin.yearRangeEnd !== coin.year
    ? `${coin.year}-${coin.yearRangeEnd}`
    : String(coin.year);
}
