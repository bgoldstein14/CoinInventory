/*
 * The decision for one image: rank every coin, drop vetoed coins
 * (match-vetoes.ts), apply the auto-assign gates, and return 'auto',
 * 'review' or 'none'. Everything upstream only measures; this is the only
 * place that commits, and it errs towards asking rather than mis-attaching.
 *
 * Background: docs/rationale/image-and-denominations.md.
 */

import { ImageMatchResult, RankedImageMatch } from '../../types/coin.model';
import { CoinSignature, Signature } from './coin-signature';
import { parseFilename, toSignature } from './filename-parser';
import { scorePair } from './match-scorer';
import { LABEL_ONLY_PHRASE, UNIDENTIFIED_PHRASE, describeVeto } from './match-vetoes';
import { denominationsAgree, isSpecificFormOf } from './reference-tables';
import { assignImportTier } from './near-match';
import {
  AUTO_MARGIN_THRESHOLD,
  AUTO_SCORE_THRESHOLD,
  CANDIDATE_MIN_SCORE,
  MAX_CANDIDATES,
  MIN_STRONG_ATTRIBUTES,
  REVIEW_SCORE_THRESHOLD
} from './matching-thresholds';
import { round } from './text-tokens';

/**
 * Decide one image, then label it with a review tier.
 *
 * `decideOneImage` is the only code allowed to set `status` and
 * `matchedRecordId`. `assignImportTier` (near-match.ts) only adds advisory
 * `tier` / `nearMatch` / `skipReason`, so tiering cannot loosen the gates.
 */
export function matchOneImage(imagePath: string, coinSignatures: CoinSignature[]): ImageMatchResult {
  return assignImportTier(decideOneImage(imagePath, coinSignatures), coinSignatures);
}

/** The three auto-assign gates. Nothing in here knows about review tiers. */
function decideOneImage(imagePath: string, coinSignatures: CoinSignature[]): ImageMatchResult {
  const parsed = parseFilename(imagePath);

  /* Gate -1: photos excluded from the automated import entirely, e.g.
   * multi-coin shots ("20¢ Collage.jpg", "1875 and 1876 3CN mini-hoard").
   * Kept separate from gate 0 because gate-0 rows still get tier 3's
   * "Attach anyway..." link and these must not; near-match.describeSkip and
   * the import modal key off `parsed.excludedFromAutoImport`. The file can
   * still be attached by hand from the per-coin gallery. */
  if (parsed.excludedFromAutoImport) {
    return {
      imagePath,
      status: 'none',
      matchedRecordId: null,
      confidence: 0,
      reason:
        `This photograph is excluded from the automated import. ${parsed.autoImportExclusionReason ?? ''}`.trim(),
      candidates: [],
      parsed,
      runnerUpGap: 0,
      // Placeholders only; `assignImportTier` overwrites all three.
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  /* Gate 0: not a photo of one coin (group shots, stamps, paper money, boxes,
   * camera default names). A veto rather than a penalty because names like
   * "Stamp - 11 - 3 cent.jpg" carry a valid-looking denomination and would
   * otherwise score respectably. No candidates are offered. */
  if (parsed.isNonCoin) {
    return {
      imagePath,
      status: 'none',
      matchedRecordId: null,
      confidence: 0,
      reason: `No inventory record matched the image filename: it does not appear to show a single coin. ${parsed.nonCoinReason ?? ''}`.trim(),
      candidates: [],
      parsed,
      runnerUpGap: 0,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  // Nothing usable in the name (e.g. "IMG_2024.jpg"): do not rank, since
  // ranking would only surface noise.
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
      runnerUpGap: 0,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  const fileSignature = toSignature(parsed);

  // Score every coin (with its veto verdict) and sort best-first; ties break
  // by coin id so ordering is deterministic.
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
      return {
        candidate,
        // Used below to compare survivors' denominations with each other.
        signature: entry.signature,
        vetoed: breakdown.vetoed,
        vetoReasons: breakdown.vetoReasons
      };
    })
    .sort((a, b) =>
      (b.candidate.score - a.candidate.score) ||
      a.candidate.coinId.localeCompare(b.candidate.coinId));

  // Vetoed coins are neither the auto match nor an offered candidate.
  const eligible = scored.filter(entry => !entry.vetoed);

  // Every coin is vetoed: report the closest one and why it was rejected.
  if (eligible.length === 0) {
    const closest = scored[0];
    return {
      imagePath,
      status: 'none',
      matchedRecordId: null,
      confidence: 0,
      reason: closest
        ? `No inventory record matched the image filename. ` +
          describeVeto(closest.candidate.coinLabel, {
            vetoed: true,
            reasons: closest.vetoReasons
          })
        : 'No inventory record matched the image filename: the inventory is empty.',
      candidates: [],
      parsed,
      runnerUpGap: 0,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  const best = eligible[0].candidate;

  /* Runner-up is measured over eligible coins only. Gate (c) means "two coins
   * fit and I cannot tell which"; a vetoed coin is not a rival. Example: a
   * "1861 3CS - PCGS PF64" photo scores 0.88 against the proof and 0.82
   * against four vetoed business strikes of the same date; counting those
   * would block every such proof photo. Gates (a) and (b) still apply. */
  const runnerUp = eligible.find(entry => entry.candidate !== best)?.candidate;
  const runnerUpScore = runnerUp ? runnerUp.score : 0;
  const gap = round(best.score - runnerUpScore);

  const shortlistEntries = eligible.filter(entry => entry.candidate.score >= CANDIDATE_MIN_SCORE);
  const shortlist = shortlistEntries.map(entry => entry.candidate);

  /* What may be offered as a manual choice. `candidates` feeds tier 3's
   * "Attach anyway" buttons and tier 2's dropdown. Vetoes stop offers that
   * contradict the filename, but not offers that rest on what the name leaves
   * out:
   *     3CS - PF64 - Obverse.jpg       no year: every 3CS proof fits
   *     1864 - PCGS PF64 - Obverse.jpg no denomination: 2c pieces fit too
   *     1867 3-cent - Obverse.jpg      generic: both 3CS and 3CN fit
   *
   * Rules (they only shorten the list, never affect status):
   * - Vague name (describeVagueness): offer nothing unless the top coin leads
   *   by AUTO_MARGIN_THRESHOLD.
   * - Generic denomination with 2+ owned specific forms (undecidedGeneric):
   *   never auto-attach and offer nothing, whatever the scores. Measured over
   *   veto survivors, not the shortlist, because it is a question about the
   *   inventory. */
  const undecidedGeneric = describeUndecidedGeneric(fileSignature, eligible);

  const vagueness = describeVagueness(fileSignature, shortlistEntries);
  const offersAreGuesswork =
    undecidedGeneric !== null ||
    (vagueness !== null && shortlist.length > 1 &&
     round(shortlist[0].score - shortlist[1].score) < AUTO_MARGIN_THRESHOLD);

  const candidates = offersAreGuesswork ? [] : shortlist.slice(0, MAX_CANDIDATES);

  // When offers are withheld, say what the name failed to tell us.
  const vagueNote = offersAreGuesswork
    ? ` ${UNIDENTIFIED_PHRASE}: ${undecidedGeneric ?? vagueness}, so ` +
      `${Math.max(shortlist.length, 2)} coins in your inventory fit it equally well.`
    : '';

  // ---- the three auto-assign gates -------------------------------------
  const clearsScore = best.score >= AUTO_SCORE_THRESHOLD;
  const hasCorroboration = best.strongAttributeCount >= MIN_STRONG_ATTRIBUTES;
  const clearsRunnerUp = gap >= AUTO_MARGIN_THRESHOLD;

  /* Slab-label photos never auto-attach on their own; they ride along with a
   * coin photo via sibling-inference.ts. This is a gate, not a veto: the
   * label is usually accurate, so it is still scored and offered. A coin whose
   * only photo is a label shot therefore goes to review. */
  const isLabelOnlyPhoto = parsed.side === 'label';

  if (clearsScore && hasCorroboration && clearsRunnerUp
      && undecidedGeneric === null && !isLabelOnlyPhoto) {
    return {
      imagePath,
      status: 'auto',
      matchedRecordId: best.coinId,
      confidence: best.score,
      reason: `Auto-matched to ${best.coinLabel}. ${best.reason} Score ${best.score.toFixed(2)}, next best ${runnerUpScore.toFixed(2)}.`,
      candidates,
      parsed,
      runnerUpGap: gap,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  if (best.score >= REVIEW_SCORE_THRESHOLD) {
    return {
      imagePath,
      status: 'review',
      matchedRecordId: null, // deliberately null: nothing is attached without a decision
      confidence: best.score,
      reason: `Needs review. ${best.reason} ` +
        `${explainWhyNotAuto(best.score, best.strongAttributeCount, gap, runnerUp, isLabelOnlyPhoto)}${vagueNote}`,
      candidates,
      parsed,
      runnerUpGap: gap,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  return {
    imagePath,
    status: 'none',
    matchedRecordId: null,
    confidence: best.score,
    reason: `No inventory record matched the image filename. Best guess ${best.coinLabel} only scored ` +
      `${best.score.toFixed(2)}.${isLabelOnlyPhoto ? ` ${LABEL_ONLY_PHRASE}.` : ''}${vagueNote}`,
    candidates,
    parsed,
    runnerUpGap: gap,
    tier: 'not-imported',
    nearMatch: null,
    skipReason: null
  };
}

/**
 * What the filename failed to say, or null when it said enough.
 *
 * - No year: every coin of that type fits.
 * - Denomination: checks whether the surviving coins disagree with each other
 *   on denomination. That catches both a missing denomination and a generic
 *   one ("3-cent" fitting 3CS and 3CN). If they all agree there is nothing
 *   vague and the candidate is still offered.
 */
function describeVagueness(
  file: Signature,
  survivors: ReadonlyArray<{ signature: Signature }>
): string | null {
  if (file.year === null) return 'the filename does not say which year';

  const denominations = survivors
    .map(entry => entry.signature.denomination)
    .filter((key): key is string => !!key);

  const theyDisagree = denominations.some(
    (key, index) => denominations.slice(index + 1).some(other => !denominationsAgree(key, other))
  );

  return theyDisagree ? 'the filename does not say which denomination' : null;
}

/**
 * Non-null when the filename uses a generic denomination and the surviving
 * coins include two or more of its specific forms, e.g. 'three cent' over
 * 3CS and 3CN, 'five cent' over half dime and nickel, 'dollar' over gold,
 * silver and trade dollars (see `isSpecificFormOf` in reference-tables.ts).
 *
 * Survivors have already passed the year veto, so they are scoped to the
 * stated year. Not a veto: each coin fits; the name just does not choose.
 */
function describeUndecidedGeneric(
  file: Signature,
  survivors: ReadonlyArray<{ signature: Signature }>
): string | null {
  if (!file.denomination) return null;

  // Distinct specific keys owned, not records: two 3CS records count once.
  const specificsOwned = new Set(
    survivors
      .map(entry => entry.signature.denomination)
      .filter(key => isSpecificFormOf(key, file.denomination))
  );

  if (specificsOwned.size < 2) return null;

  return `the filename says ${file.denominationLabel ?? file.denomination}, which does not say ` +
    `which of the ${specificsOwned.size} kinds you own for that year it means`;
}

/**
 * Human-readable explanation of which safety gate stopped an auto-match.
 *
 * @param isLabelOnlyPhoto true when the filename describes a slab label
 *        rather than the coin.
 */
export function explainWhyNotAuto(
  score: number,
  strongAttributes: number,
  gap: number,
  runnerUp: RankedImageMatch | undefined,
  isLabelOnlyPhoto = false
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
  if (isLabelOnlyPhoto) {
    blockers.push(LABEL_ONLY_PHRASE);
  }

  return blockers.length ? `Not auto-matched because ${blockers.join('; ')}.` : '';
}
