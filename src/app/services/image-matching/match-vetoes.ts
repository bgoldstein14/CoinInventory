/* ===========================================================================
 * match-vetoes.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   THE DISQUALIFICATION STEP: the handful of conflicts that do not merely
 *   make a coin a worse match, but make it NOT A MATCH AT ALL. One public
 *   entry point, `findVetoes`, plus the phrase the skip reporting looks for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS -- THE OWNER'S REPORT, VERBATIM
 * ---------------------------------------------------------------------------
 *   "I tried attaching images from the Early Proofs directory and it's not
 *    quite working too well for the close matches. First it's not a close
 *    match if the years don't match. It's also not a close match if the
 *    denomination does not match. Also, if it's a Proof/PF coin, it will
 *    never match a non-Proof/PF coin as that will always be in the file and
 *    image descriptors."
 *
 *   The matcher used to express every one of these as a LOWER SCORE. That is
 *   not strong enough. match-scorer.ts spreads its evidence across seven
 *   weighted attributes, so a coin with the WRONG YEAR could still reach the
 *   0.85 auto-assign bar on the strength of its denomination, coin type, cert
 *   number and grade -- and be attached silently. A score can always be
 *   out-voted. A veto cannot, and these three conflicts are categorical:
 *   whatever else agrees, it is not this coin.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS ONE FILE AND NOT THREE COPIES OF THE SAME TEST
 * ---------------------------------------------------------------------------
 *   There are three places that could each form their own opinion about
 *   whether a file and a coin conflict:
 *
 *     match-scorer.ts    scoring one pair
 *     match-decider.ts   the auto-assign gates and the candidate list
 *     near-match.ts      the four-attribute tier-2 test
 *
 *   near-match.ts already had its own year and denomination blockers, written
 *   separately from the scorer's. Two implementations of "do these conflict?"
 *   will eventually disagree, and the day they do, a coin the near-match test
 *   has refused will still be sitting in the candidate list for the user to
 *   click. So this file is now the ONE source of truth, and all three consult
 *   it:
 *
 *     - `scorePair` calls `findVetoes` and reports the verdict on every
 *       breakdown, so a pair cannot be scored without the caller being told
 *       it is disqualified;
 *     - `decideOneImage` drops vetoed coins before the gates run, so a vetoed
 *       coin can be neither the auto match nor an offered candidate;
 *     - `assessNearMatch` pushes the veto reasons straight into its blocker
 *       list instead of re-deriving them, so tier 2 and the candidate list can
 *       never disagree about what counts as a conflict.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT GOVERNS THE VETOES: ONLY A STATED DISAGREEMENT
 * ---------------------------------------------------------------------------
 *   A veto needs BOTH SIDES TO SAY SOMETHING, and for those two somethings to
 *   contradict each other. Silence on either side is not a conflict -- it is
 *   simply no evidence, and it goes on being handled exactly as it always was
 *   (the scorer leaves the attribute out of both numerator and denominator;
 *   the near-match test treats a missing attribute as a blocker of its own).
 *
 *   This is the matcher's oldest rule, "absence is not agreement", applied
 *   from the other end: absence is not DISagreement either. Breaking it would
 *   be catastrophic for YEAR, DENOMINATION and COIN TYPE, because a veto does
 *   more damage than a bad score. The collection is full of pairs like
 *
 *       1870 10-cent - NGC PF64Cameo - Reverse 5.jpg
 *       1870 10-cent - Obverse.jpg
 *
 *   which are two photographs of one coin, where the second simply says less.
 *   A second shot that omits the grading service, or the grade, or the
 *   variety is ordinary and expected, so none of those omissions may count
 *   against it.
 *
 * ---------------------------------------------------------------------------
 * !! THE ONE CARVE-OUT: THE STRIKE, AND ONLY THE STRIKE !!
 * ---------------------------------------------------------------------------
 *   THE OWNER HAS OVERRIDDEN THE RULE ABOVE FOR ONE DIMENSION. Verbatim:
 *
 *     "The Proof descriptor should always be part of the image file name as
 *      well as part of the inventory description otherwise it's assumed the
 *      coin is a business strike."
 *
 *   So for the STRIKE -- and for nothing else -- saying nothing is a positive
 *   statement. The two sides never both fall silent in the veto's eyes,
 *   because `detectStrike` in proof-strike.ts resolves silence to 'business'
 *   before either signature is built. By the time `isStrikeConflict` below
 *   sees them, a quiet filename is already making the claim "business
 *   strike", and it conflicts with a proof record exactly as an "MS63"
 *   filename would.
 *
 *   NOTE WHAT THIS MEANS FOR THE 1870 DIME PAIR ABOVE, because the example is
 *   deliberately left in place rather than quietly swapped for a tamer one:
 *   the two filenames no longer match the same coin on their own. The second
 *   one now says "business strike" and is DISQUALIFIED from its own proof
 *   record. That is the intended, measured cost of his rule, not an oversight
 *   -- the photo is still listed with a reason and can still be attached by
 *   hand. The example still earns its place because it shows exactly what the
 *   general rule protects for year and denomination, and exactly what the
 *   carve-out gives up for the strike.
 *
 *   WHY THE CARVE-OUT IS SOUND HERE AND NOWHERE ELSE. It rests on a fact
 *   about his data, not on logic: he is the only person who names these files
 *   and writes these records, and he writes "PF" / "Proof" (and "SP" /
 *   "Specimen") every time it is true. A filename that omits the year, by
 *   contrast, omits it all the time and means nothing by it. So:
 *
 *       year          absence is NOT evidence   (unchanged)
 *       denomination  absence is NOT evidence   (unchanged)
 *       coin type     absence is NOT evidence   (unchanged)
 *       STRIKE        absence IS evidence       <- the carve-out
 *
 *   DO NOT EXTEND IT. If a future rule wants "a filename with no mint mark
 *   means no mint mark", that is a separate question for the owner and a
 *   separate piece of evidence about his habits, not an application of this
 *   one.
 *
 * ---------------------------------------------------------------------------
 * HOW HARD A VETO IS -- AND WHAT IT DELIBERATELY DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 *   A vetoed coin is removed from the running: it cannot be auto-attached and
 *   it is not offered in the candidate list, so the user cannot pick it by
 *   accident either.
 *
 *   What a veto must NEVER do is make the matcher braver. The three
 *   auto-assign gates in match-decider.ts are unchanged and all three still
 *   have to pass; a veto is an EXTRA condition stacked on top of them, never a
 *   replacement for one.
 *
 *   THE ONE PLACE THAT RULE WAS MISREAD, AND HAS NOW BEEN CORRECTED.
 *   The runner-up margin (gate c) used to be measured against the FULL ranked
 *   list, disqualified coins included, on the theory that leaving them in
 *   could only make the matcher more cautious. In practice it made it
 *   incoherent: the owner's five 1861 Three Cent Silver records differ only
 *   by grade, so his 1861 PROOF photos were held back from an automatic
 *   attachment because four BUSINESS-STRIKE records scored close behind --
 *   records this very file had already disqualified. The margin now looks
 *   only at coins that survived the vetoes, which is what "two coins fit and
 *   I cannot tell which" was always supposed to mean. The full argument,
 *   including why this cannot mis-attach anything, is in the long comment
 *   beside the calculation in match-decider.ts.
 * =========================================================================== */

import { StrikeKind } from '../../types/coin.model';
import { Signature, formatYear } from './coin-signature';
import { strikeLabel } from './proof-strike';
import { denominationsAgree } from './reference-tables';

/**
 * The word every veto sentence contains.
 *
 * near-match.ts's skip reporting looks for it so that an image whose entire
 * candidate list was vetoed can still be told WHY it was skipped, instead of
 * being fobbed off with "no coin came close enough" when in fact one came
 * very close and was thrown out on purpose. Nothing is silently dropped.
 */
export const DISQUALIFIED_PHRASE = 'disqualified';

/**
 * Its twin: the phrase match-decider.ts writes when it refuses to OFFER any
 * coin because the filename never said which one it meant -- no year, no
 * denomination, or only the vague "3-cent" where the inventory holds both a
 * 3CS and a 3CN.
 *
 * WHY IT LIVES HERE AND NOT IN match-decider.ts, WHERE IT IS WRITTEN
 *   near-match.ts has to recognise it (same reason as above: so a skipped
 *   file is told the truth about why it was skipped), and near-match.ts is
 *   imported BY match-decider.ts. Declaring it in the decider would make the
 *   two files import each other in a circle. This file is the leaf both of
 *   them already depend on, and the two phrases belong together anyway: they
 *   are the only two ways a coin can score well and still not be offered.
 */
export const UNIDENTIFIED_PHRASE = 'The filename does not identify one coin';

/**
 * The third of the family: the phrase match-decider.ts writes when it
 * withholds an automatic attachment because the photograph is of the SLAB
 * LABEL rather than of the coin.
 *
 * The owner was asked whether a label shot may identify a coin on its own:
 *
 *     "Only alongside a coin photo."
 *
 * So the label is allowed to ride along once an actual coin image has named
 * the coin -- sibling-inference.ts places it -- but it may never be the
 * thing that does the naming. He accepted the consequence, which is that a
 * coin whose ONLY photograph is a label shot stops being attached
 * automatically; what he will not accept is that happening silently, so the
 * skip line has to SAY this rather than claim nothing matched.
 *
 * It lives here beside the other two phrases for the same reason they do:
 * near-match.ts has to recognise it when it writes the read-only skip line,
 * and near-match.ts is imported BY match-decider.ts, so declaring it in the
 * decider would put the two files in a cycle. This file is the leaf they
 * both already depend on.
 */
export const LABEL_ONLY_PHRASE =
  'the photo is of the slab label rather than the coin, and a label alone never identifies a coin';

/** Why (and whether) one file/coin pair is disqualified outright. */
export interface VetoVerdict {
  /** True when this coin must not be matched, suggested or offered. */
  vetoed: boolean;
  /**
   * One clause per conflict, phrased to be joined with "; " inside a longer
   * sentence. Empty when nothing conflicts.
   */
  reasons: string[];
}

/** The "nothing wrong here" answer, shared so every caller gets one shape. */
const NO_VETO: VetoVerdict = { vetoed: false, reasons: [] };

/**
 * Is this coin disqualified as the owner of this image?
 *
 * Pure, cheap and side-effect free: the same pair always gives the same
 * answer, so it is safe for the scorer to call it on every coin in the
 * inventory for every image.
 */
export function findVetoes(file: Signature, coin: Signature): VetoVerdict {
  const reasons: string[] = [];

  /* ---- VETO 1: THE YEAR ------------------------------------------------
   * "First it's not a close match if the years don't match."
   *
   * Both sides must state a year. A coin RECORD may hold a RANGE rather than
   * a single year -- a type-set entry is written "1916-1945" -- so the file's
   * year has to fall outside the whole range to conflict. An image never
   * carries a range, which is why only the coin side is treated as one.
   *
   * The wording is kept identical to the sentence the scorer and the
   * near-match test used before this file existed, so the skip reasons the
   * user reads (and the census that counts them) do not change shape. */
  if (file.year !== null && coin.year !== null) {
    const end = coin.yearRangeEnd ?? coin.year;
    if (file.year < coin.year || file.year > end) {
      reasons.push(`year ${file.year} does not match the record's ${formatYear(coin)}`);
    }
  }

  /* ---- VETO 2: THE DENOMINATION ----------------------------------------
   * "It's also not a close match if the denomination does not match."
   *
   * Compared with `denominationsAgree`, NOT with `===`. That matters: the
   * owner also told us "3¢ can be equivalent to 3CS or 3CN", so a filename
   * saying three cents must not be vetoed against a Three Cent Silver record.
   * The table and the reasoning live in reference-tables.ts; this is one of
   * the three places that consults it. */
  if (file.denomination && coin.denomination) {
    if (!denominationsAgree(file.denomination, coin.denomination)) {
      reasons.push(
        `denomination ${file.denominationLabel ?? file.denomination} does not match ` +
        `${coin.denominationLabel ?? coin.denomination}`
      );
    }
  }

  /* ---- VETO 3: TWO DIFFERENT STATED STRIKES ----------------------------
   * "if it's a Proof/PF coin, it will never match a non-Proof/PF coin."
   *
   * Symmetric: a proof photo must not land on a business-strike record and a
   * business-strike photo must not land on a proof record. They are different
   * coins with different values.
   *
   * SPECIMEN NOW TAKES PART TOO. It did not used to -- the first version of
   * this veto let 'specimen' conflict with nothing, on the grounds that the
   * owner's rule named only proof against non-proof and a veto he had not
   * asked for could hide a correct coin. He has since closed that question:
   *
   *     "I don't own any Specimens, however, SP or Specimen should always
   *      exist in the descriptor for such a coin."
   *
   * That is the SAME argument he made for proof, and it is what makes the
   * absence of the word informative: if every specimen says so, then a side
   * that says "MS63" or "PF64" instead is not being vague, it is saying this
   * is not a specimen. So 'specimen' against 'business' and 'specimen'
   * against 'proof' are now genuine stated disagreements.
   *
   * The cost of being wrong here is about as low as it gets: he owns no
   * specimens, so the rule changes nothing in today's data (the import-tier
   * census is unmoved by it). Its whole value is stopping a future SP69
   * presentation piece from being filed under the ordinary coin of the same
   * date -- and the empty set is the cheapest possible time to add a rule.
   *
   * AND SILENCE NOW COUNTS AS "BUSINESS STRIKE" -- READ THIS, IT IS NEW.
   * This veto used to fire only when both sides named a strike. It still
   * does, in the sense that `isStrikeConflict` below is unchanged. What
   * changed is upstream, in proof-strike.ts: a side that says nothing about
   * the strike is now RESOLVED to 'business' before it ever gets here,
   * because the owner said
   *
   *     "The Proof descriptor should always be part of the image file name
   *      as well as part of the inventory description otherwise it's assumed
   *      the coin is a business strike."
   *
   * So a proof RECORD against a filename that never mentions proof is now a
   * genuine stated disagreement and is vetoed. The long carve-out note in
   * this file's header explains why that is legitimate for the strike and
   * must not be copied to the year or the denomination.
   *
   * 'unknown' still conflicts with NOTHING, in either direction -- but it is
   * now rare, reached only when a side had no descriptive text and no grade
   * at all (an almost-empty record, or a hand-built attributes object). It is
   * the "we were given nothing" answer, not the "we were given something that
   * stayed quiet" answer; the latter is 'business' now.
   *
   * And the trap, one more time because this is where it would bite: PL,
   * DMPL, DPL and "prooflike" are BUSINESS STRIKES, not proofs. A prooflike
   * Morgan reports 'business' and matches its business-strike record exactly
   * as it should. proof-strike.ts is where that is enforced. */
  if (isStrikeConflict(file.strike, coin.strike)) {
    reasons.push(
      `the filename describes ${strikeLabel(file.strike)} but the record is ` +
      `${strikeLabel(coin.strike)}, and those are never the same coin`
    );
  }

  return reasons.length === 0 ? NO_VETO : { vetoed: true, reasons };
}

/**
 * TWO STATED STRIKES THAT DISAGREE -- in either direction.
 *
 * Written as its own named function so the whole rule is visible in three
 * lines, and so the two things that are easy to get wrong are easy to check:
 *
 *   1. 'unknown' on EITHER side returns false, always. 'unknown' no longer
 *      means "this side stayed quiet" -- proof-strike.ts resolves a quiet
 *      side to 'business' under the owner's rule -- it means "this side was
 *      EMPTY: no text, no grade, nothing that could have said". There is no
 *      statement in an empty string to contradict anything with, so an empty
 *      side never disqualifies a coin. The guard is first because it is the
 *      cheap, categorical one.
 *
 *   2. Everything else that differs conflicts. With 'unknown' already out of
 *      the way the remaining values are 'proof', 'business' and 'specimen',
 *      and no two of those are ever the same coin:
 *
 *          proof    vs business    different dies, different planchets
 *          specimen vs business    a presentation piece is not a circulation
 *                                  coin
 *          specimen vs proof       near-match.ts says the same thing about
 *                                  the grade letters: "SP (Specimen) is a
 *                                  different striking from PF altogether"
 *
 * Plain inequality rather than a list of pairs, so that adding a fourth
 * StrikeKind one day cannot leave a silently unhandled combination behind.
 */
function isStrikeConflict(left: StrikeKind, right: StrikeKind): boolean {
  if (left === 'unknown' || right === 'unknown') return false;
  return left !== right;
}

/**
 * The veto reasons as one sentence naming the coin, for the 'none' result and
 * the read-only skip list. Contains DISQUALIFIED_PHRASE by construction.
 */
export function describeVeto(coinLabel: string, verdict: VetoVerdict): string {
  return `${coinLabel} is ${DISQUALIFIED_PHRASE}: ${verdict.reasons.join('; ')}.`;
}
