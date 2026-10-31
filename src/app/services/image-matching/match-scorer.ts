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
   * True when this pair is DISQUALIFIED outright -- a stated year conflict, a
   * stated denomination conflict, or a proof against a business strike. See
   * match-vetoes.ts.
   *
   * WHY IT IS REPORTED HERE RATHER THAN APPLIED HERE
   *   The verdict rides along on every breakdown so that nothing can score a
   *   pair without being told it is disqualified -- there is no way to call
   *   the scorer and miss it. But the SCORE itself is left untouched, which
   *   is deliberate: scoring answers "how alike are these two?", and a
   *   disqualified coin can still be very alike (the owner's 1861 proof and
   *   his 1861 XF45 differ by one grade). Zeroing it here would destroy the
   *   evidence the skip reporting needs to say "this coin came closest, and
   *   here is exactly why it was thrown out".
   *
   *   ACTING on the verdict is match-decider.ts's job, and it acts on it
   *   completely: a vetoed coin is dropped before the gates run, so it can be
   *   neither the match, nor a suggestion, nor the runner-up the margin is
   *   measured against.
   */
  vetoed: boolean;
  /** One clause per conflict, for the explanation. Empty when not vetoed. */
  vetoReasons: string[];
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

  /* ---- Denomination ----------------------------------------------------
   * Compared with `denominationsAgree`, never with `===`. The owner's rule:
   * "3¢ can be equivalent to 3CS or 3CN". A filename saying three cents does
   * not say WHICH three-cent piece, so it agrees with either specific record
   * -- while 3CS and 3CN remain different coins and never agree with each
   * other. The table and the full reasoning are in reference-tables.ts.
   *
   * A generic/specific agreement earns the FULL weight and counts as a strong
   * attribute, because the two really do describe the same coin; only the
   * wording of the explanation distinguishes it, so the user can see that the
   * filename was the vaguer of the two. */
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
   * These two are scored as a PAIR, which is the one place in this file that
   * departs from "one attribute, one verdict". The reason is real-world:
   *
   *   - "PCGS" alone is nearly worthless. Hundreds of coins in this
   *     collection are PCGS-graded, so agreement is almost guaranteed and
   *     tells you nothing about WHICH coin a photo shows.
   *   - "MS63" alone is nearly worthless for the same reason -- dozens of
   *     coins share any popular grade.
   *   - "PCGS MS63" together is genuinely narrowing.
   *
   * So each contributes its (small) weight to the score independently, but
   * they yield at most ONE strong attribute between them, and only when BOTH
   * agree. A grade match on its own must never help clear the two-strong-
   * attributes gate; that is what "grade alone is weak" means in practice.
   *
   * The usual rule still holds for each half: an attribute only enters the
   * numerator or the denominator when BOTH sides have a value.
   */
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

  /* THE GRADE IS COMPARED WITH `compareGrades`, NEVER WITH `===`.
   *
   * The owner's rule, verbatim:
   *
   *     "Keep in mind that the grade might slightly differ and still be
   *      correct like 63CAM or 63 CAMEO or 63PL of 63 PL or something like
   *      that."
   *
   * He measured what `===` cost him. These two files are PHOTOGRAPHS OF ONE
   * COIN, and his record for it reads "1867 3CS - NGC PF65 Cameo":
   *
   *     1867 3CS - NGC PF65CAM - Reverse.jpg      scored 0.84 -> skipped
   *     1867 3CS - NGC PF65 Cameo - Obverse.jpg   scored 0.88 -> attached
   *
   * Nothing about the coin differed. One photo abbreviated the designation
   * and the other spelled it out, and that alone moved the score by 0.03 --
   * which is exactly the width of the gap across the 0.85 auto-match bar.
   * His Early Proofs collection is full of the same thing: PR where PCGS
   * prints it and PF where NGC does, CAM on one slab and Cameo on the next.
   *
   * WHERE THE TOLERANCE LIVES. grade-tolerance.ts, which near-match.ts's
   * tier-2 test also calls. It was MOVED there out of near-match.ts rather
   * than copied in here -- two implementations of "are these the same grade?"
   * would drift, and the day they drifted the scorer would reward a pairing
   * the near-match test refuses. See that file's header.
   *
   * THE TWO KINDS OF AGREEMENT ARE SCORED DIFFERENTLY, AND THAT IS THE POINT
   *
   *   'exact'        the SAME grade, however it is spelled. "PF65CAM" and
   *                  "PF65 Cameo"; "PR65" and "PF65"; "MS63PL" and
   *                  "MS63 PROOFLIKE". Full weight, and eligible to form the
   *                  one strong attribute the cert-company/grade pair can
   *                  earn, exactly as a character-for-character match always
   *                  was. These two sides genuinely said the same thing.
   *
   *   'extra-detail' the same grade, but ONE SIDE SAYS MORE: "MS64" against
   *                  "MS64 CAC", "PF64" against "PF64RB". Full weight,
   *                  because the grades really are the same grade and
   *                  pretending otherwise is what produced the bug above --
   *                  but NEVER a strong attribute. The two sides did not say
   *                  the same thing; one of them said more, and the
   *                  two-strong-attributes gate is where this matcher keeps
   *                  its caution. The owner's tie-breaker decides it:
   *                  "I can always force an image to be associated with a
   *                  coin manually, but the automated process should be very
   *                  descriminatory."
   *
   *   'different'    a different grade, or two decorations that contradict
   *                  (MS64 RB against MS64 BN). No weight, and it is listed
   *                  as a disagreement, exactly as before.
   *
   * MIN_STRONG_ATTRIBUTES and every threshold are untouched; so is the rule
   * that the grade can never earn a strong attribute by itself. */
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

  /* ---- the hard vetoes -------------------------------------------------
   * Asked once, here, so that every caller of `scorePair` is told. The
   * answer does not alter the score (see the note on ScoreBreakdown.vetoed);
   * match-decider.ts is what acts on it. */
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

/**
 * Render a coin's year (or year range) for the explanation text.
 *
 * MOVED to coin-signature.ts and re-exported here so the long-standing
 * `import { formatYear } from './match-scorer'` keeps working. It had to move
 * because match-vetoes.ts needs it too, and this file now imports the vetoes
 * -- leaving it here would have made the two files import each other.
 */
export { formatYear };
