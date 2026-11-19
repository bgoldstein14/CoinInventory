/*
 * Scores one filename signature against one coin signature: a 0..1 score, a
 * count of strong agreements and a plain-English reason. Deciding whether the
 * score is good enough to act on is match-decider.ts's job.
 *
 * Absence is not agreement: an attribute only one side has stays out of both
 * the numerator and the denominator.
 */

import { Signature, formatYear } from './coin-signature';
import { compareGrades } from './grade-tolerance';
import { findVetoes } from './match-vetoes';
import {
  COIN_TYPE_STRONG_SIMILARITY,
  DAMPING_FLOOR,
  DAMPING_RANGE,
  TOTAL_WEIGHT,
  WEIGHTS
} from './matching-thresholds';
import {
  denominationsAgree,
  denominationsAgreeLoosely,
  mintLabel
} from './reference-tables';
import { capitalize, titleCase } from './text-tokens';

/** Outcome of comparing one filename signature against one coin signature. */
export interface ScoreBreakdown {
  score: number;
  strongAttributeCount: number;
  reason: string;
  /**
   * True when the pair is disqualified outright (see match-vetoes.ts). The
   * score is left untouched so skip reporting can still show the closest coin
   * and why it was rejected; match-decider.ts drops vetoed coins before the gates.
   */
  vetoed: boolean;
  /** One clause per conflict, for the explanation. Empty when not vetoed. */
  vetoReasons: string[];
}

/**
 * Compare one filename signature to one coin signature.
 *
 *   score = (share of comparable evidence that agreed)
 *         x (damping by how much evidence was comparable at all)
 *
 * An attribute is comparable only when both sides have a value for it.
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

  /* ---- Denomination ----------------------------------------------------
   * Uses `denominationsAgree`, not `===`: a generic "3¢" agrees with 3CS or
   * 3CN, but 3CS and 3CN never agree (see reference-tables.ts). A
   * generic/specific agreement earns full weight; only the reason text differs. */
  if (file.denomination && coin.denomination) {
    comparable += WEIGHTS.denomination;
    if (denominationsAgree(file.denomination, coin.denomination)) {
      achieved += WEIGHTS.denomination;
      strongAttributes++;
      agreed.push(
        denominationsAgreeLoosely(file.denomination, coin.denomination)
          ? `denomination ${file.denominationLabel ?? file.denomination} is the general form of ` +
            `${coin.denominationLabel ?? coin.denomination}`
          : `denomination ${file.denominationLabel ?? file.denomination} matches`
      );
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

  /* ---- Certification company + grade ----------------------------------
   * Each adds its own small weight, but together they yield at most ONE
   * strong attribute, and only when both agree: "PCGS" or "MS63" alone barely
   * narrows a collection, "PCGS MS63" does. */
  let certCompanyAgreed = false;
  let gradeAgreed = false;

  if (file.certCompanies.length > 0 && coin.certCompanies.length > 0) {
    comparable += WEIGHTS.certCompany;
    const hit = file.certCompanies.find(c => coin.certCompanies.includes(c));
    if (hit) {
      achieved += WEIGHTS.certCompany;
      certCompanyAgreed = true;
      agreed.push(`certification company ${hit.toUpperCase()} matches`);
    } else {
      disagreed.push(
        `certification company ${file.certCompanies[0].toUpperCase()} differs from ${coin.certCompanies[0].toUpperCase()}`
      );
    }
  }

  /* Grades are compared with `compareGrades` (grade-tolerance.ts, shared with
   * near-match.ts), not `===`, so "PF65CAM" and "PF65 Cameo" agree.
   *   'exact'        same grade however spelled: full weight, may form the
   *                  cert-company/grade strong attribute.
   *   'extra-detail' one side says more ("MS64" vs "MS64 CAC"): full weight,
   *                  never a strong attribute.
   *   'different'    no weight; listed as a disagreement. */
  if (file.grade && coin.grade) {
    comparable += WEIGHTS.grade;
    const relation = compareGrades(file.grade, coin.grade).relation;

    if (relation === 'exact' || relation === 'extra-detail') {
      achieved += WEIGHTS.grade;
      // Only an EXACT agreement may help clear the corroboration gate.
      gradeAgreed = relation === 'exact';
      agreed.push(
        relation === 'exact'
          ? `grade ${file.grade.toUpperCase()} matches`
          : `grade ${file.grade.toUpperCase()} is the same grade as ${coin.grade.toUpperCase()}, ` +
            `with extra detail on one side`
      );
    } else {
      disagreed.push(`grade ${file.grade.toUpperCase()} differs from ${coin.grade.toUpperCase()}`);
    }
  }

  // One strong attribute for the PAIR, never one each.
  if (certCompanyAgreed && gradeAgreed) strongAttributes++;

  // Hard vetoes are reported, not applied to the score (see ScoreBreakdown.vetoed).
  const veto = findVetoes(file, coin);

  // Nothing at all was comparable -> no evidence -> zero. Never a match.
  if (comparable === 0) {
    return {
      score: 0,
      strongAttributeCount: 0,
      reason: 'Nothing in the filename could be compared against this record.',
      vetoed: veto.vetoed,
      vetoReasons: veto.reasons
    };
  }

  const normalized = achieved / comparable;               // 0..1, "did it agree?"
  const coverage = comparable / TOTAL_WEIGHT;             // 0..1, "how much could we check?"
  const damping = DAMPING_FLOOR + DAMPING_RANGE * coverage;
  const score = Math.max(0, Math.min(1, normalized * damping));

  return {
    score,
    strongAttributeCount: strongAttributes,
    reason: buildReason(agreed, disagreed),
    vetoed: veto.vetoed,
    vetoReasons: veto.reasons
  };
}

/** Turn the agreement lists into one explanation sentence. */
export function buildReason(agreed: string[], disagreed: string[]): string {
  const parts: string[] = [];
  if (agreed.length) parts.push(capitalize(agreed.join('; ')) + '.');
  if (disagreed.length) parts.push(capitalize(disagreed.join('; ')) + '.');
  if (!parts.length) return 'No attributes in common.';
  return parts.join(' ');
}

/**
 * Dice coefficient: 2 * shared / (sizeA + sizeB). "morgan" vs
 * "morgan liberty head" = 0.5, so a partial design name is weaker evidence.
 */
export function diceSimilarity(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Re-exported for existing importers. Defined in coin-signature.ts because
 * match-vetoes.ts needs it too, and defining it here would create a cycle.
 */
export { formatYear };
