/*
 * Tuning constants for the image matcher: attribute weights, damping and the
 * auto-assign gates. No logic lives here. Scoring tests are written against
 * these exact values, so a change here is a behaviour change.
 */

/**
 * Per-attribute weights (total 1.08; the damping table below uses that total).
 *
 * - Year is highest: it is the most discriminating fact in a collection.
 * - Mint mark is low so coins differing only by mint mark (1881-S vs 1881-O)
 *   land ~0.10 apart, inside the runner-up margin, and go to review.
 * - Cert company and grade are smallest: alone they barely discriminate.
 *   match-scorer.ts counts them as one strong attribute only when both agree.
 */
export const WEIGHTS = {
  year: 0.30,
  denomination: 0.26,
  coinType: 0.22,
  certNumber: 0.13,
  mintMark: 0.09,
  certCompany: 0.05,
  grade: 0.03
} as const;

/** Sum of every weight. Used to measure how much evidence was usable. */
export const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);

/**
 * Coverage damping: the normalized score is multiplied by
 * FLOOR + RANGE * (comparable weight / TOTAL_WEIGHT), so one matching
 * attribute cannot produce a "perfect" score.
 *
 *   coin type only        -> x0.761 (never auto)
 *   year only             -> x0.783 (never auto)
 *   denomination + type   -> x0.833 (just under the bar)
 *   year + denomination   -> x0.856 (can auto)
 *   year + denom + type   -> x0.917
 *
 * Without a year a match never auto-assigns. Ancient coins usually only have a
 * coin type, so they always go to review with a ranked shortlist.
 */
export const DAMPING_FLOOR = 0.70;
export const DAMPING_RANGE = 0.30;

/**
 * Auto-assign gate (a): minimum top score. Sits between the
 * "denomination + type" (0.833) and "year + denomination" (0.856) caps.
 */
export const AUTO_SCORE_THRESHOLD = 0.85;

/** Auto-assign gate (b): minimum number of independent strong attributes. */
export const MIN_STRONG_ATTRIBUTES = 2;

/**
 * Auto-assign gate (c): required lead over the runner-up. Mint-mark-only
 * differences (~0.10) go to review; year differences (~0.30) do not.
 */
export const AUTO_MARGIN_THRESHOLD = 0.15;

/** Below this score the image is reported as 'none' (candidates may still be listed). */
export const REVIEW_SCORE_THRESHOLD = 0.35;

/** Candidates scoring below this are not worth showing at all. */
export const CANDIDATE_MIN_SCORE = 0.15;

/** How many ranked candidates to hand to the UI. */
export const MAX_CANDIDATES = 5;

/** A coin-type token overlap at or above this counts as a "strong" agreement. */
export const COIN_TYPE_STRONG_SIMILARITY = 0.5;

/** Earliest plausible mint year; anything older is almost certainly not a year. */
export const MIN_COIN_YEAR = 1600;
