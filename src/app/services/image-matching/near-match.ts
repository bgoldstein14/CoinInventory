/* ===========================================================================
 * near-match.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   STAGE 4: sorting every already-decided match result into one of THREE
 *   IMPORT TIERS, so the review screen can ask the user a cheap question
 *   instead of an expensive one (or no question at all).
 *
 *     'matched'      the matcher is certain  -> attach it, nothing to ask
 *     'near'         one yes/no away         -> ask, but only yes/no
 *     'not-imported' nothing to ask about    -> skip it and report it
 *
 *   Public entry points:
 *     `assignImportTier`  - the stage itself: result in, result + tier out.
 *     `assessNearMatch`   - the four-attribute test for ONE file/coin pair.
 *
 *   WHAT MOVED OUT: `compareGrades` and the grade-equivalence tables, which
 *   this file used to own outright. They now live in grade-tolerance.ts so
 *   that match-scorer.ts can apply the SAME tolerance when it scores a pair,
 *   instead of comparing grade strings with `===`. They are re-exported from
 *   here unchanged; see the long note where they used to be.
 *
 *   WHAT THIS FILE NO LONGER OWNS: whether two STATED years or two STATED
 *   denominations conflict. Those tests, plus the proof-against-business-
 *   strike rule, moved to match-vetoes.ts so that the scorer, the decider and
 *   this file all read one answer. `assessNearMatch` now adopts that verdict
 *   and only adds the ABSENCE checks, which are stricter than any veto.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT AN EDIT TO match-decider.ts
 * ---------------------------------------------------------------------------
 *   match-decider.ts owns the three AUTO-ASSIGN GATES, and those gates embody
 *   the product owner's standing rule:
 *
 *       "Silently filing an image under the wrong coin is much worse than
 *        asking."
 *
 *   NOTHING IN THIS FILE MAY WEAKEN THOSE GATES, and nothing in it can: this
 *   stage runs AFTER the decision is made, reads `status` without ever writing
 *   it, and never sets `matchedRecordId`. A 'near' row arrives at the review
 *   screen with no coin attached and leaves it with no coin attached unless the
 *   user presses a button. The tiers exist to make the ASKING cheaper, not to
 *   make the matcher braver.
 *
 *   Keeping it in its own module (with its own spec) means the caution in
 *   match-decider.ts and the convenience rules in here can each be reviewed on
 *   their own, and a future change to one cannot quietly change the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TIERS ARE SPLIT WHERE THEY ARE
 * ---------------------------------------------------------------------------
 *   The photo library is ~2,140 files. Before this stage existed the review
 *   screen had only two buckets: "attached automatically" and "a human must
 *   look at this". Everything the matcher had no opinion about -- a group shot,
 *   a stamp, a camera-default name like IM000025.JPG, an ancient with no year
 *   -- landed in the same manual list as a genuine 1881-S / 1881-O Morgan
 *   near-miss, and cost the user exactly the same attention. At 2,140 files
 *   that is not a review screen, it is a second job.
 *
 *   The split below is therefore about WHAT QUESTION CAN BE ASKED:
 *
 *   TIER 1 'matched'
 *       All three auto gates passed. No question. (The user can still untick
 *       or Skip a photo -- it is one of only two places a Skip button appears.)
 *
 *   TIER 2 'near'
 *       The filename and the coin agree on all FOUR identifying attributes --
 *       year, coin type, denomination and grade -- so we are looking at the
 *       same coin; but something ELSE is off (a mint mark that disagrees, a
 *       variety, a cert number, or simply two coins fitting equally well), so
 *       the gates would not let it through. That is a question with a yes/no
 *       answer: "this one?" The user answers it in one click, or picks a
 *       different coin from the short list of other near matches, or skips.
 *
 *   TIER 3 'not-imported'
 *       The four-attribute test failed against every candidate, so there is no
 *       apparent match and therefore no yes/no question to ask -- asking would
 *       just be making the user do the matcher's job by hand, 203 times. These
 *       are skipped automatically and shown in a READ-ONLY list with no
 *       buttons, exactly like the "Not imported" panels in the QIF and CSV
 *       importers. Nothing is silently dropped: every row is listed with its
 *       filename, what the matcher managed to read out of it, and why it was
 *       skipped.
 *
 *   Note that tier 3 contains both of the old 'none' rows AND the 'review'
 *   rows that cannot clear the four-attribute bar. That second group is where
 *   the saving comes from.
 * =========================================================================== */

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

/* ===========================================================================
 * THE GRADE TOLERANCE -- MOVED OUT, RE-EXPORTED HERE
 * ---------------------------------------------------------------------------
 * `compareGrades`, `parseGradeParts`, GRADE_DESIGNATION_SYNONYMS and the rest
 * of the grade-equivalence machinery used to be written out in this file,
 * roughly 400 lines of it, between the imports above and the four-attribute
 * test below.
 *
 * THEY NOW LIVE IN grade-tolerance.ts, and they moved for one reason:
 * match-scorer.ts needs them too. The scorer compared grades with a plain
 * `===`, so the owner's "1867 3CS - NGC PF65CAM - Reverse.jpg" scored 0.84
 * against the record that spells the designation out, while its own obverse
 * shot scored 0.88 and attached -- two photographs of one coin, separated by
 * nothing but an abbreviation and landing on opposite sides of the 0.85 bar.
 *
 * The scorer could not simply import this file: THIS file imports the scorer
 * (for `diceSimilarity`), so the two would have formed a cycle. Hence a new
 * leaf module that both can depend on.
 *
 * THE CODE WAS MOVED, NOT COPIED. Two implementations of "are these the same
 * grade?" would drift, and the day they drifted the scorer would be rewarding
 * a pairing this file refuses. The re-export below exists only so that the
 * long-standing `import { compareGrades } from './near-match'` in the specs
 * and elsewhere keeps working -- it is one implementation with two doors, the
 * same arrangement match-scorer.ts has with `formatYear`.
 * ========================================================================= */
export {
  NEAR_MATCH_EXTRA_DESIGNATIONS,
  GRADE_DESIGNATION_SYNONYMS,
  parseGradeParts,
  compareGrades
} from './grade-tolerance';
export type { GradeDesignationGroup, GradeRelation, GradeComparison } from './grade-tolerance';


/* ===========================================================================
 * THE FOUR-ATTRIBUTE NEAR-MATCH TEST
 * ========================================================================= */

/** Why one file/coin pair is (or is not) a near match. */
export interface NearMatchVerdict {
  /** True only when all four required attributes agree. */
  isNear: boolean;
  /** Which of the four failed, in words fit to show the user. Empty when near. */
  blockers: string[];
  /** How the two grades relate. */
  grade: GradeComparison;
  /**
   * What is OFF despite the four agreeing -- the reason this is "near" rather
   * than automatic. A mint mark that disagrees, a cert number, a variety.
   */
  discrepancies: string[];
}

/**
 * Is this coin a NEAR MATCH for this filename?
 *
 * All four of year, coin type, denomination and grade must agree. If any of
 * them is ABSENT on either side, that is a failure too, not a free pass:
 * "absence is not agreement" is the matcher's oldest rule and it holds here.
 * A filename with no grade therefore cannot produce a near match, which is
 * deliberate -- without the grade there is nothing holding the pairing
 * together except a year and a denomination that dozens of coins share.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONFLICT TESTS LIVE NOW
 * ---------------------------------------------------------------------------
 * This function used to decide FOR ITSELF whether two years or two
 * denominations disagreed. It no longer does. Those tests moved to
 * match-vetoes.ts, which the scorer and the decider also consult, and this
 * function now simply adopts their answer.
 *
 * That is not tidiness, it is correctness. Two copies of "do these conflict?"
 * eventually drift, and the day they drift is the day a coin this test has
 * refused is still sitting in the candidate list waiting to be clicked. One
 * source of truth makes that impossible.
 *
 * What stays here is the part the veto deliberately does NOT do: the ABSENCE
 * checks. A veto needs both sides to state something and contradict; this
 * tier is stricter still and requires all four attributes to be PRESENT and
 * to agree. So "the filename carries no year" is a blocker here while it is
 * not a veto anywhere else.
 */
export function assessNearMatch(file: Signature, coin: Signature): NearMatchVerdict {
  const blockers: string[] = [];
  const discrepancies: string[] = [];

  /* ---- 0. THE HARD VETOES ---------------------------------------------
   * A stated year conflict, a stated denomination conflict, or a proof
   * against a business strike. Listed first because they are categorical:
   * whatever else agrees, this is not the coin. */
  blockers.push(...findVetoes(file, coin).reasons);

  // ---- 1. YEAR IS PRESENT ON BOTH SIDES --------------------------------
  // Whether two STATED years disagree is the veto's business, above.
  if (file.year === null) {
    blockers.push('the filename carries no year');
  } else if (coin.year === null) {
    blockers.push('the coin record has no year');
  }

  // ---- 2. COIN TYPE ----------------------------------------------------
  // "Agrees" uses the same bar the scorer uses for a STRONG coin-type
  // agreement, so the two parts of the system cannot drift apart.
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
      // Same coin, but the two descriptions are not word-for-word. Worth
      // mentioning, not worth refusing over.
      discrepancies.push(
        `the coin type is written differently: "${titleCase(file.coinTypeTokens.join(' '))}" vs "${titleCase(coin.coinTypeTokens.join(' '))}"`
      );
    }
  }

  /* ---- 3. DENOMINATION IS PRESENT ON BOTH SIDES ------------------------
   * As with the year, whether two STATED denominations conflict is decided by
   * the shared veto above -- including the owner's "3¢ is equivalent to 3CS
   * or 3CN" rule, which this test must not second-guess. Only absence is
   * handled here. */
  if (!file.denomination) {
    blockers.push('the filename carries no denomination');
  } else if (!coin.denomination) {
    blockers.push('the coin record has no denomination');
  }

  // ---- 4. GRADE (with the "extra information" tolerance) ---------------
  const grade = compareGrades(file.grade, coin.grade);
  if (grade.relation === 'missing' || grade.relation === 'different') {
    blockers.push(asClause(grade.description));
  } else if (grade.relation === 'extra-detail') {
    discrepancies.push(asClause(grade.description));
  }

  /* ---- what else is off ------------------------------------------------
   * These never block a near match -- they are precisely the "but something
   * else seems off" the owner described, and they are the reason the user is
   * being asked rather than told. */
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

/**
 * Turn a standalone sentence into a clause that can be joined with others by
 * "; " — no capital at the front, no full stop at the back. Every blocker and
 * discrepancy ends up inside a longer sentence, so they all have to read as
 * clauses or the skip reasons come out as "..., but The filename does not...".
 */
function asClause(sentence: string): string {
  const trimmed = sentence.replace(/\.$/, '');
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/* ===========================================================================
 * STAGE 4 ITSELF
 * ========================================================================= */

/**
 * Stamp an import tier onto a decided match result.
 *
 * This is a pure function of its inputs and it NEVER touches `status`,
 * `matchedRecordId`, `confidence` or `candidates`. The only fields it writes
 * are `tier`, `nearMatch` and `skipReason`, all of which are new and advisory.
 * That is what makes it impossible for this stage to attach anything.
 */
export function assignImportTier(
  result: ImageMatchResult,
  coinSignatures: readonly CoinSignature[]
): ImageMatchResult {
  // TIER 1. The gates in match-decider.ts already said yes. Nothing to add.
  if (result.status === 'auto') {
    return { ...result, tier: 'matched', nearMatch: null, skipReason: null };
  }

  const file = toSignature(result.parsed);
  const byId = new Map(coinSignatures.map(entry => [entry.coin.id, entry]));

  const near: Array<{ candidate: RankedImageMatch; verdict: NearMatchVerdict }> = [];
  let topVerdict: NearMatchVerdict | null = null;

  // Candidates arrive best-first, so the first one that passes is the one we
  // suggest and the rest become the dropdown.
  for (const candidate of result.candidates) {
    const entry = byId.get(candidate.coinId);
    if (!entry) continue;
    const verdict = assessNearMatch(file, entry.signature);
    topVerdict ??= verdict;
    if (verdict.isNear) near.push({ candidate, verdict });
  }

  // TIER 3. No candidate agreed on all four, so there is no apparent match and
  // no yes/no question worth asking. Skip it, but say exactly why.
  if (near.length === 0) {
    return {
      ...result,
      tier: 'not-imported',
      nearMatch: null,
      skipReason: describeSkip(result, topVerdict)
    };
  }

  // TIER 2. Same coin on all four attributes, something else off.
  const best = near[0];
  const alternatives = near.length - 1;

  const discrepancies = [...best.verdict.discrepancies];
  if (alternatives > 0) {
    /* This is the owner's first ambiguous case: "a number of images match
     * multiple coins". The alternatives are offered as a dropdown rather than
     * as more cards, because they are all answers to the SAME question. */
    discrepancies.push(
      `${alternatives} other coin${alternatives === 1 ? '' : 's'} in your inventory fit${alternatives === 1 ? 's' : ''} this filename just as well`
    );
  }

  const nearMatch: NearMatchDetail = {
    suggestedCoinId: best.candidate.coinId,
    suggestedCoinLabel: best.candidate.coinLabel,
    // Only the candidates that independently passed the four-attribute test.
    // Offering the rest would be offering a coin we have already judged wrong.
    candidates: near.map(entry => entry.candidate),
    gradeRelation: best.verdict.grade.relation === 'exact' ? 'exact' : 'extra-detail',
    gradeNote: best.verdict.grade.description,
    discrepancies
  };

  return { ...result, tier: 'near', nearMatch, skipReason: null };
}

/**
 * One honest sentence for the read-only "Not imported" list.
 *
 * The product owner has objected to silent dropping before, and the reporting
 * is the point of that panel: every row says what it is and why it is there.
 */
function describeSkip(result: ImageMatchResult, topVerdict: NearMatchVerdict | null): string {
  const parsed = result.parsed;

  /* Checked BEFORE isNonCoin, because the two overlap and this one is more
   * specific. "Group PHOTO-2023-06-02-13-15-48.jpg" is both -- `group` is a
   * GROUP_SHOT_WORD and a multi-coin marker -- and the honest sentence is the
   * one that says it was held out of the automated run on purpose, not the
   * generic "this is not one coin". Nothing is ever dropped without a line
   * here; the owner has objected to silent dropping before. */
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
    /* An empty candidate list usually means nothing scored well. But there
     * are two other ways to arrive here, and in BOTH of them a coin came
     * very close indeed, so "nothing came close" would simply be untrue --
     * and the owner has objected to silent, inaccurate dropping before:
     *
     *   DISQUALIFIED  every coin was thrown out by a hard veto (wrong year,
     *                 wrong denomination, a proof against a business strike).
     *   UNIDENTIFIED  several coins fit, and the FILENAME could not say which
     *                 -- it gave no year, or no denomination, or only the
     *                 vague "3-cent" where the inventory holds both a 3CS and
     *                 a 3CN. See match-decider.ts.
     *
     * In each case the decider has already written the honest sentence, which
     * names the closest coin and says exactly what went wrong, so it is
     * passed through rather than paraphrased. */
    const unidentified = result.reason.indexOf(UNIDENTIFIED_PHRASE);
    if (unidentified >= 0) {
      /* Only the tail is wanted here. The full sentence also walks through
       * which auto-assign gate was missed, which is true but beside the
       * point in a one-line "why was this left out?" column: the answer is
       * that the NAME was not specific enough, and the rest is noise. */
      return result.reason.slice(unidentified).trim();
    }
    return result.reason.includes(DISQUALIFIED_PHRASE)
      ? result.reason
      : 'No coin in the inventory came close enough to be worth suggesting.';
  }

  const top = result.candidates[0];
  const percent = Math.round(top.score * 100);

  /* THE LABEL SHOT GETS ITS OWN SENTENCE, AND IT COMES FIRST.
   *
   * The owner allows a photograph of the slab's certification label to ride
   * along with a coin photo but never to identify a coin on its own ("Only
   * alongside a coin photo"), and he accepted what follows from that: a coin
   * whose ONLY photograph is a label shot stops being attached
   * automatically.
   *
   * What he did NOT accept is that happening silently. A label shot usually
   * agrees with its coin on every attribute there is -- it is a picture of
   * the words, after all -- so the four-attribute blockers below would often
   * be EMPTY and this line would read "not enough of the filename could be
   * tied to it", which is the opposite of the truth. Saying the real reason
   * is also actionable: the fix is to photograph the coin, or to attach this
   * one by hand. */
  if (result.parsed.side === 'label') {
    return `Closest coin is ${top.coinLabel} at ${percent}%, but ${LABEL_ONLY_PHRASE}. ` +
      'Attach it by hand, or import a photo of the coin itself and this one will follow it.';
  }

  const why = topVerdict && topVerdict.blockers.length > 0
    ? topVerdict.blockers.join('; ')
    : 'not enough of the filename could be tied to it';

  // Naming the closest coin AND the reason is what lets the user fix the
  // underlying data: usually the record is missing the grade, or the filename
  // is missing the denomination.
  return `Closest coin is ${top.coinLabel} at ${percent}%, but ${why}.`;
}
