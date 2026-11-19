/*
 * Sorts every decided match result into an import tier, so the review screen
 * only asks questions it can ask cheaply:
 *
 *   'matched'      all auto gates passed; nothing to ask.
 *   'near'         file and coin agree on year, coin type, denomination and
 *                  grade, but something else is off (mint mark, cert number,
 *                  several equally good coins). Asked as a yes/no.
 *   'not-imported' the four-attribute test failed for every candidate
 *                  (includes 'none' and weak 'review' rows). Shown in a
 *                  read-only list with the reason it was skipped.
 *
 * This stage runs after the decision and never writes `status` or
 * `matchedRecordId`, so it cannot loosen the gates in match-decider.ts.
 * Conflict tests come from match-vetoes.ts; this file adds only the
 * stricter "must be present" checks.
 */

import {
  ImageMatchResult,
  NearMatchDetail,
  RankedImageMatch
} from '../../types/coin.model';
import { CoinSignature, Signature } from './coin-signature';
import { toSignature } from './filename-parser';
import { GradeComparison, compareGrades } from './grade-tolerance';
import { diceSimilarity } from './match-scorer';
import {
  DISQUALIFIED_PHRASE,
  LABEL_ONLY_PHRASE,
  UNIDENTIFIED_PHRASE,
  findVetoes
} from './match-vetoes';
import { COIN_TYPE_STRONG_SIMILARITY } from './matching-thresholds';
import { mintLabel } from './reference-tables';
import { titleCase } from './text-tokens';

// Grade tolerance lives in grade-tolerance.ts (shared with match-scorer.ts);
// re-exported for existing importers.
export {
  NEAR_MATCH_EXTRA_DESIGNATIONS,
  GRADE_DESIGNATION_SYNONYMS,
  parseGradeParts,
  compareGrades
} from './grade-tolerance';
export type { GradeDesignationGroup, GradeRelation, GradeComparison } from './grade-tolerance';

/** Why one file/coin pair is (or is not) a near match. */
export interface NearMatchVerdict {
  /** True only when all four required attributes agree. */
  isNear: boolean;
  /** Which of the four failed, in words fit to show the user. Empty when near. */
  blockers: string[];
  /** How the two grades relate. */
  grade: GradeComparison;
  /** What is off despite the four agreeing (mint mark, cert number, variety). */
  discrepancies: string[];
}

/**
 * Is this coin a near match for this filename?
 *
 * Year, coin type, denomination and grade must all be present on both sides
 * and agree; a missing attribute is a blocker. Stated conflicts come from
 * the shared vetoes in match-vetoes.ts.
 */
export function assessNearMatch(file: Signature, coin: Signature): NearMatchVerdict {
  const blockers: string[] = [];
  const discrepancies: string[] = [];

  // 0. Hard vetoes.
  blockers.push(...findVetoes(file, coin).reasons);

  // 1. Year present on both sides (conflicts handled by the veto).
  if (file.year === null) {
    blockers.push('the filename carries no year');
  } else if (coin.year === null) {
    blockers.push('the coin record has no year');
  }

  // 2. Coin type, using the scorer's strong-agreement bar.
  if (file.coinTypeTokens.length === 0) {
    blockers.push('the filename names no coin type');
  } else if (coin.coinTypeTokens.length === 0) {
    blockers.push('the coin record names no coin type');
  } else {
    const similarity = diceSimilarity(file.coinTypeTokens, coin.coinTypeTokens);
    if (similarity < COIN_TYPE_STRONG_SIMILARITY) {
      blockers.push(
        `coin type "${titleCase(file.coinTypeTokens.join(' '))}" does not match "${titleCase(coin.coinTypeTokens.join(' '))}"`
      );
    } else if (similarity < 1) {
      // Not word-for-word: worth mentioning, not refusing over.
      discrepancies.push(
        `the coin type is written differently: "${titleCase(file.coinTypeTokens.join(' '))}" vs "${titleCase(coin.coinTypeTokens.join(' '))}"`
      );
    }
  }

  // 3. Denomination present on both sides (conflicts handled by the veto).
  if (!file.denomination) {
    blockers.push('the filename carries no denomination');
  } else if (!coin.denomination) {
    blockers.push('the coin record has no denomination');
  }

  // 4. Grade, tolerating extra detail on one side.
  const grade = compareGrades(file.grade, coin.grade);
  if (grade.relation === 'missing' || grade.relation === 'different') {
    blockers.push(asClause(grade.description));
  } else if (grade.relation === 'extra-detail') {
    discrepancies.push(asClause(grade.description));
  }

  // Discrepancies never block a near match; they are why the user is asked.
  if (file.mintMark && coin.mintMark && file.mintMark !== coin.mintMark) {
    discrepancies.push(`mint mark ${mintLabel(file.mintMark)} differs from ${mintLabel(coin.mintMark)}`);
  }
  if (file.mintMark && !coin.mintMark) {
    discrepancies.push(`the filename says mint ${mintLabel(file.mintMark)} but the record has no mint mark`);
  }
  if (!file.mintMark && coin.mintMark) {
    discrepancies.push(`the record is mint ${mintLabel(coin.mintMark)} but the filename does not say`);
  }
  if (file.certNumbers.length > 0 && coin.certNumbers.length > 0
      && !file.certNumbers.some(n => coin.certNumbers.includes(n))) {
    discrepancies.push('the certification number does not match');
  }
  if (file.certCompanies.length > 0 && coin.certCompanies.length > 0
      && !file.certCompanies.some(c => coin.certCompanies.includes(c))) {
    discrepancies.push(
      `certification company ${file.certCompanies[0].toUpperCase()} differs from ${coin.certCompanies[0].toUpperCase()}`
    );
  }

  return { isNear: blockers.length === 0, blockers, grade, discrepancies };
}

/** Turn a sentence into a clause for joining with "; " (lowercase start, no full stop). */
function asClause(sentence: string): string {
  const trimmed = sentence.replace(/\.$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Stamp an import tier onto a decided match result. Pure; writes only the
 * advisory `tier`, `nearMatch` and `skipReason` fields.
 */
export function assignImportTier(
  result: ImageMatchResult,
  coinSignatures: readonly CoinSignature[]
): ImageMatchResult {
  // Tier 1: the gates already said yes.
  if (result.status === 'auto') {
    return { ...result, tier: 'matched', nearMatch: null, skipReason: null };
  }

  const file = toSignature(result.parsed);
  const byId = new Map(coinSignatures.map(entry => [entry.coin.id, entry]));

  const near: Array<{ candidate: RankedImageMatch; verdict: NearMatchVerdict }> = [];
  let topVerdict: NearMatchVerdict | null = null;

  // Candidates arrive best-first: the first that passes is suggested, the
  // rest become the dropdown.
  for (const candidate of result.candidates) {
    const entry = byId.get(candidate.coinId);
    if (!entry) continue;
    const verdict = assessNearMatch(file, entry.signature);
    topVerdict ??= verdict;
    if (verdict.isNear) near.push({ candidate, verdict });
  }

  // Tier 3: no candidate agreed on all four. Skip it and say why.
  if (near.length === 0) {
    return {
      ...result,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: describeSkip(result, topVerdict)
    };
  }

  // Tier 2: same coin on all four attributes, something else off.
  const best = near[0];
  const alternatives = near.length - 1;

  const discrepancies = [...best.verdict.discrepancies];
  if (alternatives > 0) {
    // Several coins fit; alternatives go in the dropdown.
    discrepancies.push(
      `${alternatives} other coin${alternatives === 1 ? '' : 's'} in your inventory fit${alternatives === 1 ? 's' : ''} this filename just as well`
    );
  }

  const nearMatch: NearMatchDetail = {
    suggestedCoinId: best.candidate.coinId,
    suggestedCoinLabel: best.candidate.coinLabel,
    // Only candidates that passed the four-attribute test.
    candidates: near.map(entry => entry.candidate),
    gradeRelation: best.verdict.grade.relation === 'exact' ? 'exact' : 'extra-detail',
    gradeNote: best.verdict.grade.description,
    discrepancies
  };

  return { ...result, tier: 'near', nearMatch, skipReason: null };
}

/** The skip reason shown in the read-only "Not imported" list. */
function describeSkip(result: ImageMatchResult, topVerdict: NearMatchVerdict | null): string {
  const parsed = result.parsed;

  // Checked before isNonCoin: the two can overlap ("Group PHOTO-....jpg")
  // and this reason is more specific.
  if (parsed.excludedFromAutoImport) {
    return parsed.autoImportExclusionReason?.trim()
      || 'Held out of the automated import. You can still attach it to a coin by hand.';
  }
  if (parsed.isNonCoin) {
    return parsed.nonCoinReason?.trim()
      || 'The filename does not appear to describe a single coin.';
  }
  if (parsed.isEmpty) {
    return 'Nothing about a coin could be read from the filename.';
  }
  if (result.candidates.length === 0) {
    /* No candidates usually means nothing scored well, but it can also mean
     * every coin was vetoed (DISQUALIFIED) or the filename did not say which
     * coin (UNIDENTIFIED). The decider's reason is passed through for those. */
    const unidentified = result.reason.indexOf(UNIDENTIFIED_PHRASE);
    if (unidentified >= 0) {
      // Only the tail; the gate-by-gate part is noise in a one-line column.
      return result.reason.slice(unidentified).trim();
    }
    return result.reason.includes(DISQUALIFIED_PHRASE)
      ? result.reason
      : 'No coin in the inventory came close enough to be worth suggesting.';
  }

  const top = result.candidates[0];
  const percent = Math.round(top.score * 100);

  // Label shots usually have no blockers, so give the real reason instead of
  // the generic fallback below.
  if (result.parsed.side === 'label') {
    return `Closest coin is ${top.coinLabel} at ${percent}%, but ${LABEL_ONLY_PHRASE}. ` +
      'Attach it by hand, or import a photo of the coin itself and this one will follow it.';
  }

  const why = topVerdict && topVerdict.blockers.length > 0
    ? topVerdict.blockers.join('; ')
    : 'not enough of the filename could be tied to it';

  return `Closest coin is ${top.coinLabel} at ${percent}%, but ${why}.`;
}
