/* ===========================================================================
 * matching-thresholds.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Every "magic number" the image matcher uses, and nothing else. No logic
 *   lives here -- just named constants and the reasoning behind each value.
 *
 * WHY IT IS ITS OWN FILE
 *   These are the dials. When the matcher feels too eager (it auto-attaches
 *   images it should have asked about) or too shy (it sends obvious matches to
 *   review), this is the ONLY file you need to open. Keeping the numbers apart
 *   from the code that consumes them means you can read the whole tuning story
 *   in one screen, and it makes an accidental change very easy to spot in a
 *   diff.
 *
 *   Treat a change in here as a behaviour change: the scoring tests in
 *   image-matching.service.spec.ts are written against these exact values.
 * =========================================================================== */

/* ---------------------------------------------------------------------------
 * TUNING CONSTANTS
 * These are the numbers you would change if the matcher feels too eager or
 * too shy. Each one is explained so you can reason about a change.
 * ------------------------------------------------------------------------- */

/**
 * Per-attribute weights. They sum to 1.0 so the raw score is already a
 * fraction of "perfect evidence".
 *
 * Year is weighted highest because in a coin collection the year is the single
 * most discriminating fact -- most collections have many Morgan Dollars but
 * only one or two from any given year+mint.
 *
 * Mint mark is weighted LOW on purpose. That looks backwards, but it is the
 * key to defect #2: two coins that differ only by mint mark (1881-S vs 1881-O)
 * will end up only ~0.10 apart, which is inside the runner-up margin, so they
 * both get sent to review instead of one being silently chosen.
 */
export const WEIGHTS = {
  year: 0.30,
  denomination: 0.26,
  coinType: 0.22,
  certNumber: 0.13,
  mintMark: 0.09
} as const;

/** Sum of every weight (1.0). Used to measure "how much evidence was usable". */
export const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, w) => sum + w, 0);

/**
 * Coverage damping.
 *
 * Problem: if the only comparable attribute is the year and it matches, the
 * naive normalized score is 1.0 -- "perfect", from one coincidence. That is
 * exactly defect #1.
 *
 * Fix: multiply the normalized score by how much of the available evidence we
 * were actually able to compare (`coverage`). With these constants:
 *
 *   coverage 0.30 (year only)           -> x0.79  -> max score 0.79  (never auto)
 *   coverage 0.48 (denomination + type) -> x0.844 -> just under the bar
 *   coverage 0.56 (year + denomination) -> x0.868 -> can auto
 *   coverage 0.78 (year + denom + type) -> x0.934 -> comfortably auto
 *   coverage 0.87 (all four core attrs) -> x0.961 -> comfortably auto
 *
 * So a filename that only gives us a denomination and a design name (no year)
 * can never auto-assign: we would have no way to tell a 1904 Liberty Head
 * Double Eagle from a 1907 one.
 */
export const DAMPING_FLOOR = 0.70;
export const DAMPING_RANGE = 0.30;

/**
 * Auto-assign gate (a): the top candidate must score at least this much.
 * 0.85 is set just above the "denomination + coin type, no year" case (0.844)
 * and just below the "year + denomination" case (0.868).
 */
export const AUTO_SCORE_THRESHOLD = 0.85;

/**
 * Auto-assign gate (b): at least this many independent strong attributes must
 * agree. One matching attribute is never enough, no matter how clean.
 */
export const MIN_STRONG_ATTRIBUTES = 2;

/**
 * Auto-assign gate (c): the top candidate must beat the runner-up by this much.
 *
 * 0.15 is chosen so that a difference in a single low-weight attribute cannot
 * decide a match. Two coins differing only by mint mark land ~0.10 apart; two
 * coins differing only by year land ~0.30 apart. So mint-mark-only ambiguity
 * always goes to review, while a clear year difference does not.
 */
export const AUTO_MARGIN_THRESHOLD = 0.15;

/**
 * Below this score we do not even suggest the coin as the "best guess" --
 * the image is reported as 'none'. (Weak candidates may still be listed.)
 */
export const REVIEW_SCORE_THRESHOLD = 0.35;

/** Candidates scoring below this are not worth showing at all. */
export const CANDIDATE_MIN_SCORE = 0.15;

/** How many ranked candidates to hand to the UI. */
export const MAX_CANDIDATES = 5;

/** A coin-type token overlap at or above this counts as a "strong" agreement. */
export const COIN_TYPE_STRONG_SIMILARITY = 0.5;

/** Earliest plausible mint year; anything older is almost certainly not a year. */
export const MIN_COIN_YEAR = 1600;
