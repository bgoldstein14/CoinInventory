 /*
 * match-decider.ts
 *
 * WHAT THIS FILE OWNS
 *   STAGE 3: the DECISION for one image. `matchOneImage` ranks every coin,
 *   drops the ones a HARD VETO disqualifies, applies the three auto-assign
 *   safety gates, and returns one of the three result shapes
 *   ('auto' / 'review' / 'none'). `explainWhyNotAuto` writes the sentence
 *   telling the user which gate stopped an auto-match.
 *
 *   The vetoes themselves live in match-vetoes.ts -- a year conflict, a
 *   denomination conflict, a proof against a business strike. They are an
 *   EXTRA constraint stacked on top of the three gates and never a
 *   replacement for one; the comment beside the runner-up calculation below
 *   explains the one place where that distinction takes real care.
 *
 * WHY IT IS ITS OWN FILE
 *   This is the file that embodies the rule "silently filing an image under
 *   the wrong coin is much worse than asking". Everything upstream just
 *   measures; this is the only place that COMMITS. Isolating it means the
 *   safety gates are impossible to weaken by accident while editing parsing
 *   or scoring.
 *
 *   The gates are deliberately conservative and all three must pass together.
 *
 *   The numismatics and the longer background for this whole directory are
 *   in docs/rationale/image-and-denominations.md.
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
 * Decide one image, then label it with a REVIEW TIER.
 *
 * The two halves are deliberately separate calls:
 *
 *   `decideOneImage`   the three safety gates below. Unchanged, and the only
 *                      thing in the system allowed to set `status` and
 *                      `matchedRecordId`.
 *   `assignImportTier` stage 4, in near-match.ts. It READS the decision and
 *                      adds `tier` / `nearMatch` / `skipReason`; it cannot
 *                      write anything the gates own.
 *
 * Keeping the tier stage outside the gate logic is the whole point. The review
 * screen was reorganised into three tiers to cut the manual work on a
 * 2,140-file run, and that reorganisation must not be able to loosen what gets
 * attached without being asked. It cannot, because everything it writes is
 * advisory.
 */
export function matchOneImage(imagePath: string, coinSignatures: CoinSignature[]): ImageMatchResult {
  return assignImportTier(decideOneImage(imagePath, coinSignatures), coinSignatures);
}

/** The three auto-assign gates. Nothing in here knows about review tiers. */
function decideOneImage(imagePath: string, coinSignatures: CoinSignature[]): ImageMatchResult {
  const parsed = parseFilename(imagePath);

  /* ---- GATE MINUS ONE: is this a photograph the automated run must not
   *      touch at all? ---------------------------------------------------
   *
   * Two groups, one rule: counterfeits and multi-coin shots are NEVER
   * attached automatically and never OFFERED as attachable in the automated
   * import.
   *
   *     FAKE - 1860 3CS - VF - Obverse.jpg       a counterfeit
   *     1861 Counterfeit 3CS - Obverse.jpg       a counterfeit
   *     20¢ Collage.jpg                          several coins at once
   *     1875 and 1876 3CN mini-hoard - Obverse   several coins at once
   *
   * WHY IT COMES BEFORE GATE ZERO, AND WHY IT IS NOT FOLDED INTO IT.
   * Both gates return 'none' with no candidates, so for AUTO-ATTACHMENT they
   * are identical. They differ one step later: a gate-zero row still carries
   * tier 3's opt-in "Attach anyway..." link, and that link is precisely the
   * offer these rows must not get. Suppressing it needs the two cases to stay
   * distinguishable, so this gate runs first and writes its own reason, and
   * `near-match.describeSkip` and the import modal both key off
   * `parsed.excludedFromAutoImport`.
   *
   * The counterfeits are the more dangerous half and deserve the earlier gate
   * on their own merits: unlike a stamp or a camera dump, a fake carries a
   * complete, valid, high-scoring descriptor. "FAKE - 1860 3CS - VF" names a
   * year, a denomination AND a grade, and would beat most genuine photos in a
   * race for a real 1861 3CS record.
   *
   * *** AND NOTHING HERE MAKES THE FILE UNATTACHABLE. *** No picture file is
   * ever off limits from being chosen by hand, however irrelevant its
   * descriptor. The row is still listed with its reason, and the per-coin
   * image gallery -- which never calls this function -- still attaches it to
   * anything the user points at. This gate governs the AUTOMATED decision
   * only. */
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

  /* ---- GATE ZERO: is this even a photo of one coin? --------------------
   * A hard veto, checked before anything is scored. Group shots, non-coin
   * items, containers and camera default names all land here:
   *
   *     Gold Coins.JPG                     a group shot
   *     20th Century Type Set.JPG          a group shot
   *     Stamp - 11 - 3 cent.jpg            a STAMP that contains "3 cent"
   *     3-cent paper - Large.jpg           fractional currency, not a coin
   *     Sovereign Proof Boxes.jpg          the box, not a coin
   *     Coin_026.JPG                       a camera default name
   *
   * The first two traps are why this is a veto and not a penalty: both of
   * those filenames carry a perfectly valid-looking denomination and would
   * otherwise score respectably against a real Three Cent coin. Filing a
   * stamp photo under a coin is precisely the silent mis-attachment this
   * whole service exists to prevent, so we return 'none' and offer NO
   * candidates -- there is nothing here to confirm.
   */
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
      // Placeholders only. `assignImportTier` overwrites all three on the way
      // out; they are spelled out here because the fields are required and
      // because a half-built result must never look like a 'matched' one.
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

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
      runnerUpGap: 0,
      // Placeholders only. `assignImportTier` overwrites all three on the way
      // out; they are spelled out here because the fields are required and
      // because a half-built result must never look like a 'matched' one.
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  const fileSignature = toSignature(parsed);

  // Score every coin, then sort best-first. Ties are broken by coin id so the
  // ordering is deterministic rather than dependent on array order.
  //
  // Each entry carries the coin's VETO verdict alongside its candidate row.
  // `scorePair` works that out for us; see match-vetoes.ts for what the three
  // vetoes are and why they are categorical rather than a score penalty.
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
        // Carried along so the "did the filename actually identify a coin?"
        // test below can compare the SURVIVORS' denominations with each
        // other, not just each survivor with the filename.
        signature: entry.signature,
        vetoed: breakdown.vetoed,
        vetoReasons: breakdown.vetoReasons
      };
    })
    .sort((a, b) =>
      (b.candidate.score - a.candidate.score) ||
      a.candidate.coinId.localeCompare(b.candidate.coinId));

  /* ---- GATE ZERO AND A HALF: the hard vetoes ---------------------------
   * A vetoed coin is out of the running entirely -- not the auto match, and
   * not an offered candidate either. A conflict disqualifies a coin OUTRIGHT;
   * half-disqualifying it (hidden from the automatic decision but still one
   * click away in the dropdown) leaves exactly the mis-attachment the vetoes
   * exist to stop.
   */
  const eligible = scored.filter(entry => !entry.vetoed);

  // Everything in the inventory conflicts with this filename. There is
  // nothing to attach and nothing to ask about -- but we still say which coin
  // came closest and exactly why it was thrown out. Nothing is dropped
  // silently.
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
      // See the note above: overwritten by `assignImportTier`.
      tier: 'not-imported',
      nearMatch: null,
      skipReason: null
    };
  }

  const best = eligible[0].candidate;

  /* ---- the runner-up, measured over the ELIGIBLE coins only ------------
   *
   * WHAT THE MARGIN GATE IS FOR
   *   Gate (c) exists to express ONE idea: "two coins fit this filename and
   *   I cannot tell which one it is." When that is true, guessing is worse
   *   than asking, so the match is held back for review.
   *
   * WHY VETOED COINS ARE NOT IN THE DENOMINATOR
   *   A disqualified coin is not a rival interpretation; it is not an
   *   interpretation at all. Counting it would make the matcher refuse to
   *   decide between one coin and several it has already decided against.
   *
   *   The worked example is the five 1861 Three Cent Silver records in this
   *   collection -- one PCGS/CAC PF64 proof and four business strikes (AU,
   *   EF, XF, XF45) that differ from it in nothing but grade. A photo called
   *   "1861 3CS - PCGS PF64 - Obverse.jpg" scores 0.88 against the proof and
   *   0.82 against each business strike, because grade carries the smallest
   *   weight in the scorer (0.03). Measured over the full list the gap is
   *   0.06, under the 0.15 bar, so the auto-match is refused -- even though
   *   all four runners-up were ALREADY disqualified by the
   *   proof-against-business-strike veto. Every proof photo then lands in the
   *   skipped list, one line at a time.
   *
   * WHY NARROWING THE SET IS STILL SAFE
   *   A vetoed coin cannot be attached, cannot be suggested and cannot be
   *   offered; it is already gone. Widening a gap over coins that no longer
   *   exist in the decision cannot attach anything to the WRONG coin: the
   *   only row this can promote is one where exactly one coin survived every
   *   veto and beat the score bar and the two-strong-attributes bar on its
   *   own merits. Gates (a) and (b) are untouched, and so is every veto.
   */
  const runnerUp = eligible.find(entry => entry.candidate !== best)?.candidate;
  const runnerUpScore = runnerUp ? runnerUp.score : 0;
  const gap = round(best.score - runnerUpScore);

  const shortlistEntries = eligible.filter(entry => entry.candidate.score >= CANDIDATE_MIN_SCORE);
  const shortlist = shortlistEntries.map(entry => entry.candidate);

  /* ---- WHAT MAY BE OFFERED AS A MANUAL CHOICE -------------------------
   * `candidates` is not just debugging detail. It is the list of coins the
   * tier-3 "Attach anyway" panel puts in front of the user as buttons, and
   * the list tier 2 draws its dropdown from. So it is held to the standing
   * rule for everything automatic: a user can always force an image onto a
   * coin by hand, but the automated process must be very discriminatory.
   *
   * The vetoes already guarantee that nothing OFFERED CONTRADICTS the
   * filename. What they cannot do is notice when the filename simply DOES
   * NOT SAY, because a veto needs both sides to state something. Three real
   * shapes of that gap, all of them a coin offered on the strength of what
   * the name leaves out:
   *
   *     3CS - PF64 - Obverse.jpg      no year -> every 3CS proof in the
   *                                   inventory is offered, so a photo of the
   *                                   1862 coin is offered the 1865 coin
   *     1864 - PCGS PF64 - Obverse.jpg
   *                                   no denomination -> the 1864 TWO CENT
   *                                   pieces are offered for a 3CS photo
   *     1867 3-cent - Obverse.jpg     "3-cent" does not say silver or nickel,
   *                                   so the 1867 3CN records are offered
   *                                   alongside the 1867 3CS
   *
   * None of those is a mis-match: every coin listed really is compatible with
   * the words in the name. They are worse than that -- they are the matcher
   * presenting a coin flip as a ranked recommendation.
   *
   * THE RULE. When the filename leaves an identifying attribute unsaid, the
   * top coin must be CLEARLY AHEAD of the next one before anything is
   * offered, by the same margin the auto-assign gate uses. If it is not,
   * nothing is offered and the skip line says why.
   *
   * Reusing AUTO_MARGIN_THRESHOLD here is deliberate and is not a new dial:
   * it is already the number that means "these two are too close to call".
   * Nothing in matching-thresholds.ts changes.
   *
   * WHAT THIS DOES NOT DO. It never widens anything -- it can only shorten
   * the list. It does not touch `status`, `matchedRecordId` or the three
   * gates below, so it cannot attach anything. And it leaves the ordinary
   * case completely alone: a name that gives its year and its denomination
   * is not vague, so the 97%-scoring "1881 Morgan Dollar NGC 2599001.jpg"
   * (which fails the near-match bar only because it states no grade) still
   * arrives with its coin at the top of the list, which is the whole reason
   * the escape hatch exists.
   */
  /* ---- THE GENERIC DENOMINATION THAT HAS NOT CHOSEN -------------------
   * When a photo is called "1867 3-cent" and the inventory holds both an 1867
   * Three Cent Silver and an 1867 Three Cent Nickel, the rule is NEVER
   * AUTO-ATTACH -- not "attach when one is clearly ahead".
   *
   * So this is deliberately NOT a margin test: `undecidedGeneric` below
   * disqualifies the automatic attachment outright, whatever the scores do,
   * and it also empties the offer list, because a coin flip presented as a
   * ranked recommendation is worse than no recommendation.
   *
   * It is measured over the VETO SURVIVORS rather than the shortlist, because
   * the question it asks is about the INVENTORY, not about scores: "given the
   * year this filename states, does the collection hold more than one of the
   * coins this word could mean?" A 3CN that scores badly is still a 3CN owned
   * for that year, and it still means the name did not say which. */
  const undecidedGeneric = describeUndecidedGeneric(fileSignature, eligible);

  const vagueness = describeVagueness(fileSignature, shortlistEntries);
  const offersAreGuesswork =
    undecidedGeneric !== null ||
    (vagueness !== null && shortlist.length > 1 &&
     round(shortlist[0].score - shortlist[1].score) < AUTO_MARGIN_THRESHOLD);

  const candidates = offersAreGuesswork ? [] : shortlist.slice(0, MAX_CANDIDATES);

  /* The honest sentence for the read-only list. Nothing is ever dropped
   * silently: if we have just refused to name a coin, we say what the name
   * failed to tell us and how many coins therefore fit it equally well. */
  const vagueNote = offersAreGuesswork
    ? ` ${UNIDENTIFIED_PHRASE}: ${undecidedGeneric ?? vagueness}, so ` +
      `${Math.max(shortlist.length, 2)} coins in your inventory fit it equally well.`
    : '';

  // ---- the three auto-assign gates -------------------------------------
  const clearsScore = best.score >= AUTO_SCORE_THRESHOLD;
  const hasCorroboration = best.strongAttributeCount >= MIN_STRONG_ATTRIBUTES;
  const clearsRunnerUp = gap >= AUTO_MARGIN_THRESHOLD;

  /* ---- GATE FIVE: THE SLAB LABEL --------------------------------------
   * A photograph of the slab's certification label -- no coin visible, just
   * the paper -- may identify a coin ONLY alongside a coin photo. So a label
   * shot may RIDE ALONG once an actual coin image has identified the coin
   * (sibling-inference.ts does that, after every image has been decided), but
   * it may never be the thing that does the identifying.
   *
   * WHY IT IS A GATE AND NOT A VETO. The label photo is not WRONG about the
   * coin -- it usually states the year, the service, the cert number and the
   * grade, and states them more reliably than any other photo, because it is
   * a picture of the words. What it cannot do is prove a coin was
   * photographed at all. So the pairing is still scored, still ranked and
   * still OFFERED; only the silent automatic attachment is withheld.
   *
   * THE CONSEQUENCE, STATED PLAINLY BECAUSE IT WAS ACCEPTED: a coin whose
   * ONLY photograph is a label shot will not be attached automatically. It
   * lands in the review list, and `explainWhyNotAuto` below says which gate
   * stopped it rather than pretending nothing matched. */
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
      // See the note above: overwritten by `assignImportTier`.
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
      // See the note above: overwritten by `assignImportTier`.
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
    // See the note above: overwritten by `assignImportTier`.
    tier: 'not-imported',
    nearMatch: null,
    skipReason: null
  };
}

/**
 * WHAT THE FILENAME FAILED TO SAY -- or null when it said enough.
 *
 * Two clauses only, because there are only two attributes in this collection
 * that tell one coin from another on their own:
 *
 *   THE YEAR. Absent from the name, every coin of that type in the inventory
 *   fits. The 3CS proofs in this collection run 1861-1867 and differ in
 *   nothing else, so a name with no year fits six coins as well as it fits one.
 *
 *   THE DENOMINATION. Tested differently, and this is the interesting half:
 *   rather than asking whether the FILENAME stated one, it asks whether the
 *   surviving coins AGREE WITH EACH OTHER about what denomination they are.
 *   That single test catches both ways the name can fail:
 *
 *     "1864 - PCGS PF64 - Obverse.jpg"   says no denomination at all, and the
 *                                        survivors are a Three Cent Silver
 *                                        and six Two Cent pieces
 *     "1867 3-cent - Obverse.jpg"        says "three cent", which the
 *                                        equivalence table makes compatible
 *                                        with BOTH 3CS and 3CN, and the
 *                                        inventory holds both for 1867
 *
 *   In each case the survivors disagree among themselves, which is precisely
 *   the definition of "the name did not say which". And when they all agree
 *   -- a nameless denomination in a year where he owns only one coin -- there
 *   is nothing to be vague about and this returns null, so the one good
 *   candidate is still offered.
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
 * THE FILENAME USED THE GENERAL WORD AND THE INVENTORY HOLDS MORE THAN ONE OF
 * THE PARTICULAR COINS -- or null when there is nothing to be undecided about.
 *
 * THE RULE IS NOT JUST ABOUT THREE-CENT PIECES. Three-cent pieces are only
 * the commonest instance. The SHAPE of the problem is general, and
 * reference-tables.ts already names it: some denomination keys are GENERIC
 * and stand over two or more SPECIFIC coins that share a face value but are
 * not the same coin.
 *
 *     'three cent'  stands over  3CS and 3CN            (overlap 1865-1873)
 *     'five cent'   stands over  Half Dime and Nickel   (overlap 1866-1873)
 *     'cent'        stands over  Large Cent and Small Cent  (overlap 1856-57)
 *     'dollar'      stands over  Gold / Silver / Trade Dollar
 *     'gold eagle'  stands over  the four Eagle face values
 *
 * In every one of those rows the generic AGREES with each specific -- that is
 * what makes it generic, and it is why no veto fires and why the coins all
 * score alike. So the agreement is real and the ambiguity is real at the same
 * time, which is exactly the situation that needs a rule of its own rather
 * than a threshold.
 *
 * `isSpecificFormOf` is the predicate that reads those rows, so this rule
 * inherits the table instead of hard-coding anything about three-cent pieces.
 * Add a generic row there one day and this rule covers it the same afternoon.
 *
 * WHAT COUNTS AS "FOR THAT YEAR". The survivors handed in here have already
 * been through the vetoes, and a stated year that does not match is one of
 * them. So when the filename gives a year, every coin still standing is a
 * coin of that year and the scoping is free. When the filename gives NO year,
 * every candidate of every year is still standing -- which is even more
 * undecided, not less, and `describeVagueness` has already caught it.
 *
 * WHY THIS IS NOT A VETO. A veto removes a coin. Here nothing is wrong with
 * any individual coin -- each one genuinely fits the words. What is wrong is
 * the SET: the name picked out more than one coin and said nothing to
 * separate them. So the right answer is to refuse to choose: no automatic
 * attachment, no offered guesses, and a skip line that says the name did not
 * say which. Either one can still be attached by hand.
 */
function describeUndecidedGeneric(
  file: Signature,
  survivors: ReadonlyArray<{ signature: Signature }>
): string | null {
  if (!file.denomination) return null;

  // Which of the PARTICULAR coins this general word stands over does he
  // actually own (for this year)? Counted as distinct keys, not records --
  // two 3CS records of one year are one answer to "which coin is it?".
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
 *        rather than the coin. A label shot may ride along with a coin photo
 *        but never identify a coin by itself, and a skip line saying "nothing
 *        matched" when the real answer is "this is a picture of the
 *        paperwork" would be exactly the silent, inaccurate dropping this
 *        matcher avoids.
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
