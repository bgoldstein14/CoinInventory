/* ===========================================================================
 * proof-strike.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   Deciding HOW A COIN WAS STRUCK -- proof, business strike, specimen, or
 *   "the evidence does not say". One public entry point, `detectStrike`,
 *   which both sides of a comparison call so that a filename and a coin
 *   record are always judged by the identical rules.
 *
 * WHY THIS MATTERS AT ALL
 *   The product owner, verbatim:
 *
 *     "if it's a Proof/PF coin, it will never match a non-Proof/PF coin as
 *      that will always be in the file and image descriptors."
 *
 *   A proof and a business strike of the same date and denomination are two
 *   DIFFERENT coins. They are struck from different dies, on polished planchets,
 *   usually in tiny numbers, and they are worth very different money. Filing a
 *   proof photograph under the business-strike record (or the reverse) is
 *   exactly the silent mis-attachment this whole matcher exists to prevent.
 *   So the disagreement is a hard veto, not a score penalty -- see
 *   match-vetoes.ts, which is the only place this verdict is acted upon.
 *
 * ===========================================================================
 * !!! READ THIS BEFORE YOU TOUCH ANYTHING IN HERE !!!
 * ---------------------------------------------------------------------------
 * "PROOFLIKE" IS NOT A PROOF. IT IS A BUSINESS STRIKE.
 * ---------------------------------------------------------------------------
 *   PL, DMPL, DPL, "prooflike" and "proof like" all describe an ORDINARY
 *   CIRCULATION COIN whose fields came out of the press with a mirror finish
 *   because the dies were fresh. The coin was never struck as a proof. The
 *   designation exists precisely to say "this looks like a proof but is not
 *   one", and it is commonest on exactly the coin this collection is full of:
 *   the Morgan dollar.
 *
 *   The obvious implementation -- `text.includes('proof')` -- therefore gets
 *   it EXACTLY BACKWARDS. Every PL and DMPL Morgan would be classified as a
 *   proof, and the veto would then disqualify each one of them from matching
 *   its own (business-strike) record. The feature would destroy the matches it
 *   was built to protect.
 *
 *   Every test below that mentions "like" is guarding that trap, and
 *   `PROOFLIKE_FAMILY` is checked BEFORE the bare word "proof" everywhere it
 *   appears. If you add a spelling, add it to PROOFLIKE_FAMILY first.
 *
 *   near-match.ts carries the same warning from the other direction: its
 *   GRADE_DESIGNATION_SYNONYMS table deliberately keeps 'pl' and 'dmpl' in
 *   their own groups, with the comment "mirrored surfaces on a BUSINESS
 *   strike". The two files must keep agreeing about this.
 * ===========================================================================
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS EVIDENCE, AND IN WHICH ORDER
 * ---------------------------------------------------------------------------
 *   1. THE GRADE, which is authoritative whenever it yields a verdict.
 *      A grading service never prints a proof on an MS label or a business
 *      strike on a PF label, so the letters in front of the number are a
 *      statement of fact rather than a description:
 *
 *          PF / PR  -> proof            (PCGS prints PR, NGC prints PF)
 *          SP       -> specimen         (a third thing -- see below)
 *          MS, BU, UNC, GEM, AU, XF/EF, VF, VG, AG, FR, PO, G, F
 *                   -> business strike  (the circulated / uncirculated scale)
 *
 *   2. THE WORDS, only when the grade said nothing. A standalone "proof" in
 *      the filename or in the record's coin type, variety or notes.
 *
 *   The order is what keeps the notes field safe. A record's `notes` is free
 *   text and could easily say "bought at a proof set auction" about a
 *   perfectly ordinary coin -- but such a coin almost always carries a real
 *   grade as well ("MS63"), and the grade wins. Notes only get a say about a
 *   record that has no grade at all. If a correct match is ever vetoed as
 *   proof-versus-business, the notes field is the first place to look.
 *
 * ---------------------------------------------------------------------------
 * WHAT WE DO ABOUT SP (SPECIMEN) -- THE OWNER HAS NOW ANSWERED
 * ---------------------------------------------------------------------------
 *   SP is neither of the other two. A specimen strike is a presentation piece:
 *   better made than a business strike, not struck as a proof. near-match.ts
 *   records the same judgement about the grade letters ("SP (Specimen) is a
 *   different striking from PF altogether").
 *
 *   !! THIS SECTION USED TO SAY THE OPPOSITE. If you remember reading that
 *   'specimen' vetoes nothing, that is out of date -- it now vetoes both of
 *   the others. The old text is gone rather than hedged, because a confident
 *   explanation of behaviour the code no longer has is worse than silence.
 *
 *   The first version of this file reported 'specimen' and let it disqualify
 *   NOTHING, reasoning that the owner's rule named only proof against
 *   non-proof, and that a veto he had not asked for could hide a correct coin
 *   from him entirely. That was the right call on the evidence available. He
 *   has since supplied the missing evidence:
 *
 *     "I don't own any Specimens, however, SP or Specimen should always
 *      exist in the descriptor for such a coin."
 *
 *   That is precisely the argument he gave for proof -- the designation is
 *   reliably WRITTEN DOWN when it is true -- and it is what turns its absence
 *   into information rather than a gap. If every specimen says "SP", then a
 *   side that says "MS67" instead has positively stated that this is not a
 *   specimen, and the two statements contradict each other.
 *
 *   DECISION: 'specimen' now takes part in the strike veto on the same terms
 *   as the other two. specimen-vs-business and specimen-vs-proof are both
 *   hard vetoes; see match-vetoes.ts, which is still the only place any of
 *   this is acted upon.
 *
 *   WHY THIS IS A CHEAP CHANGE TO MAKE. He owns no specimens, so on today's
 *   data it disqualifies nothing at all and the import-tier census does not
 *   move. The usual objection to a new veto -- that a wrong one silently
 *   hides a correct coin -- has no bite against an empty set. The value is
 *   entirely in the future: the first SP coin he buys will not be filed under
 *   the ordinary coin of the same date. An empty set is the cheapest possible
 *   moment to tighten a rule, and the most expensive moment is after the
 *   wrong photo is already attached.
 *
 *   AND SILENCE NOW MEANS BUSINESS STRIKE FOR SPECIMEN TOO. See the section
 *   "SILENCE IS A STATEMENT" below: a side that does not say SP is not being
 *   vague about specimen-ness, it is saying "not a specimen" -- which lands
 *   it in 'business' along with everything else that stays quiet.
 *
 * ---------------------------------------------------------------------------
 * WHAT ABOUT "PROOF SET"?
 * ---------------------------------------------------------------------------
 *   Nothing extra is needed, and that is worth writing down so nobody adds a
 *   special case for it later. A proof set is still proof coinage, so the
 *   bare word "proof" giving the verdict 'proof' is correct. And a FILENAME
 *   saying "Proof Set" never gets this far anyway: non-coin-detector.ts sees
 *   the group-shot word "set" and match-decider.ts returns 'none' with no
 *   candidates at all, long before any coin is scored. The same already
 *   happens for the real filename "Sovereign Proof Boxes.jpg" via "boxes".
 *
 * ---------------------------------------------------------------------------
 * !! SILENCE IS A STATEMENT, AND THE STATEMENT IS "BUSINESS STRIKE" !!
 * ---------------------------------------------------------------------------
 *   THIS SECTION USED TO SAY THE EXACT OPPOSITE. If you remember reading
 *   "silence is not a statement" here, that is out of date and the old text
 *   has been deleted rather than hedged. The owner has now given the rule in
 *   its absolute form, and this is his sentence verbatim:
 *
 *     "The Proof descriptor should always be part of the image file name as
 *      well as part of the inventory description otherwise it's assumed the
 *      coin is a business strike."
 *
 *   Read the last clause slowly, because it is the whole change: *otherwise
 *   it's assumed the coin is a business strike*. He is not saying the matcher
 *   lacks evidence when nobody mentions proof. He is saying that the absence
 *   of the word IS the evidence -- an affirmative statement that the coin is
 *   an ordinary circulation strike.
 *
 *   He has now said this three times, each more specific than the last:
 *
 *     1. "if it's a Proof/PF coin, it will never match a non-Proof/PF coin as
 *         that will always be in the file and image descriptors."
 *     2. "Proofs are always described as such in the inventory as well as the
 *         pictures."
 *     3. the sentence quoted above.
 *
 *   SO WHY IS SILENCE INFORMATIVE HERE WHEN IT IS NOT INFORMATIVE ANYWHERE
 *   ELSE? Because of a fact about HIS DATA, not a fact about logic. The
 *   proof designation is reliably WRITTEN DOWN by the only person who writes
 *   these names and these records -- him. A filename that omits it is not a
 *   filename where the information happened to be dropped; it is a filename
 *   about a coin that has no such designation to omit. That reasoning does
 *   NOT transfer to the year, the denomination or the coin type, where plenty
 *   of his real filenames genuinely do leave the attribute out:
 *
 *       1884 3CN - Obverse 2.jpg      <- no grade, no service, and that is
 *                                        a perfectly normal second shot
 *
 *   So this file turns silence into 'business', and match-vetoes.ts keeps
 *   "absence is not disagreement" for every OTHER attribute. The carve-out is
 *   strike-only and deliberately so; the long note in that file's header
 *   spells out the boundary.
 *
 *   THE PRICE, STATED PLAINLY. The 1870 dime pair that used to be this
 *   section's worked example --
 *
 *       1870 10-cent - NGC PF64Cameo - Reverse 5.jpg      <- says PF
 *       1870 10-cent - Obverse.jpg                        <- says nothing
 *
 *   -- no longer matches as a pair by itself. The second filename now reports
 *   'business' and is vetoed against its own proof record. The owner has been
 *   told this and accepts it, under his standing tie-breaker: "I can always
 *   force an image to be associated with a coin manually, but the automated
 *   process should be very descriminatory." A photograph refused here is
 *   still listed, still explained, and still attachable in one click; a
 *   photograph wrongly attached is silent and may never be noticed.
 *
 * ---------------------------------------------------------------------------
 * WHEN 'unknown' CAN STILL HAPPEN -- IT IS NOW RARE, NOT IMPOSSIBLE
 * ---------------------------------------------------------------------------
 *   'unknown' survives in StrikeKind for exactly one situation: THERE WAS NO
 *   INPUT AT ALL. `detectStrike` answers 'unknown' only when the descriptive
 *   text is blank/whitespace AND the grade is blank/whitespace, i.e. when
 *   there is nothing that COULD have carried the designation. Silence from a
 *   source that exists means business strike; silence from a source that does
 *   not exist means nothing.
 *
 *   In practice that leaves two cases:
 *
 *     - a coin RECORD with no coinType, no variety, no notes and no grade --
 *       an almost-empty row;
 *     - a hand-built `ParsedImageAttributes` that never went through
 *       `parseFilename` (see `toSignature` in filename-parser.ts, which
 *       defaults the field). Real filenames always have text, so a real
 *       photograph never lands here.
 *
 *   'unknown' still vetoes nothing, which is what makes it the safe answer
 *   for "we were handed an empty object".
 *
 * ===========================================================================
 * "ISN'T THIS JUST THE GRADE AGAIN?" -- THE QUESTION, AND THE MEASURED ANSWER
 * ---------------------------------------------------------------------------
 * THE OWNER ASKED THIS, AND IT IS A GOOD QUESTION. His words:
 *
 *     "Proofs are just a grade clarification so there's not a lot special
 *      about them either."
 *
 * The argument behind it is sound on its face. `PF65` and `MS65` differ in
 * their grade BASE LETTERS, and `compareGrades` in grade-tolerance.ts already
 * returns 'different' for that. So why carry a separate `StrikeKind` field on
 * every signature, with its own detection path in this file, to re-derive
 * something the grade already expresses?
 *
 * IT WAS INVESTIGATED PROPERLY RATHER THAN ARGUED ABOUT, by running every
 * photograph of every one of his seven coin accounts against every coin in
 * them and counting. Of the pairs that are plausibly the same coin -- same
 * year, agreeing denomination -- 2,435 were examined and 89 were disqualified
 * by the strike veto. The breakdown is the whole answer:
 *
 *     strike veto fired, compareGrades said 'different'       10   (11%)
 *     strike veto fired, compareGrades said 'missing'         79   (89%)
 *
 * EIGHTY-NINE PER CENT OF THE VETOES ARE INVISIBLE TO THE GRADE, and not by
 * accident -- BY CONSTRUCTION. `compareGrades` returns 'missing' the moment
 * EITHER side lacks a grade, because with nothing to compare there is nothing
 * it can honestly say. But "one side says nothing" is precisely the situation
 * the owner's rule is ABOUT:
 *
 *     "The Proof descriptor should always be part of the image file name as
 *      well as part of the inventory description otherwise it's assumed the
 *      coin is a business strike."
 *
 * You cannot express "absence is evidence" through a function whose answer
 * for absence is "no evidence". That is not an implementation detail of
 * `compareGrades` that could be patched; it is the correct behaviour for a
 * grade comparator, and changing it would break the far larger number of
 * honest cases where a second shot simply omits the grade.
 *
 * Two further things the grade cannot reach, both small but both real:
 *
 *   THE WORDS. A record whose coin type reads "Proof Gold" and carries no
 *   grade at all, or a filename like "1957 Sovereign Proof.jpg". `strikeFromText`
 *   finds those; there is no grade for `compareGrades` to look at.
 *
 *   THE PROOFLIKE TRAP. A grade field holding nothing but "PROOFLIKE" has no
 *   base letters, so `compareGrades('PROOFLIKE', 'MS63')` reports 'different'
 *   -- which is exactly backwards, since a prooflike Morgan IS an MS63
 *   business strike. This file reports 'business' for both sides and the pair
 *   is correctly left alone. The strike layer PROTECTS the match here; it does
 *   not merely duplicate the grade.
 *
 * ---------------------------------------------------------------------------
 * AND THE ASYMMETRY HE PUT HIS FINGER ON -- WHY IT IS RIGHT, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 *   The fair challenge is this: if proofs are not special, why is a PF-vs-MS
 *   conflict a hard VETO while an MS63-vs-XF45 conflict is merely SCORED? The
 *   same census answers that too. Of the same 2,435 pairs, 802 had
 *   compareGrades say 'different'; only 10 of those were strike conflicts. The
 *   other 792 are ordinary grade disagreements, and they are scored rather
 *   than vetoed.
 *
 *   THE ASYMMETRY IS NOT ABOUT PROOFS BEING SPECIAL. It is about which part
 *   of a grade is a STATEMENT OF FACT and which part is a JUDGEMENT:
 *
 *     THE BASE LETTERS ARE A FACT. A grading service never prints a proof on
 *       an MS label or a business strike on a PF label. "PF" and "MS" are not
 *       two opinions about one coin; they are two different coins, struck from
 *       different dies on different planchets and worth different money.
 *
 *     THE NUMBER IS A JUDGEMENT. "XF" against "XF45", "VF" against "VF30",
 *       "EF" against "XF" -- his own filenames and his own records disagree
 *       like this constantly, about one coin, because one of them was typed
 *       from memory and the other copied off a slab. Vetoing on that would
 *       disqualify hundreds of correct matches.
 *
 *   So the strike dimension is not machinery re-deriving the grade. It is the
 *   FACTUAL SUBSET of the grade, extracted so it can be treated categorically,
 *   PLUS the word evidence the grade field does not carry, PLUS the
 *   silence-is-a-statement rule the grade field cannot express.
 *
 * ---------------------------------------------------------------------------
 * CONCLUSION: NO SIMPLIFICATION IS AVAILABLE, AND THE ONE THAT WAS HAS BEEN
 * TAKEN ALREADY
 * ---------------------------------------------------------------------------
 *   Collapsing `StrikeKind` into the grade comparison would silently drop 79
 *   of 89 vetoes -- every one of them a photograph that would then be free to
 *   attach itself to the wrong coin without anybody being told. That is the
 *   exact failure the owner cares most about, so the machinery stays.
 *
 *   The redundancy that DID exist has already gone: sibling-inference.ts used
 *   to carry its own `proofExcluded(file, coin)` gate beside the veto check,
 *   and once silence began resolving to 'business' that gate could no longer
 *   decide anything the veto had not already decided. It was deleted. What is
 *   left of it there is a single `if` that only chooses the WORDING of the
 *   skip line, and the comment beside it says so in capitals.
 *
 *   The whole strike concept is now four things and no more: this detector,
 *   one field on `Signature`, one veto in match-vetoes.ts, and one sentence
 *   of phrasing in sibling-inference.ts. There is nothing left to remove that
 *   is not behaviour he asked for.
 * =========================================================================== */

import { StrikeKind } from '../../types/coin.model';
import {
  GRADE_BASE_WORDS,
  GRADE_MODIFIER_WORDS
} from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';

/* ---------------------------------------------------------------------------
 * THE GRADE LETTERS, SORTED INTO THE THREE KINDS OF STRIKE
 * ------------------------------------------------------------------------- */

/** Grade letters that only ever appear on a PROOF slab. */
const PROOF_GRADE_BASES: ReadonlySet<string> = new Set(['pf', 'pr']);

/** Grade letters that only ever appear on a SPECIMEN slab. */
const SPECIMEN_GRADE_BASES: ReadonlySet<string> = new Set(['sp']);

/**
 * Grade letters that only ever appear on a BUSINESS STRIKE.
 *
 * This is the whole circulated-to-uncirculated ladder. A proof is never given
 * one of these: a proof that has been mishandled is graded "PF55", not "AU55".
 * So any of these letters is a POSITIVE statement that the coin is not a
 * proof, which is what gives the veto something to disagree with.
 *
 * 'g' and 'f' (Good and Fine) are included even though grade-parser.ts refuses
 * to read a lone "F" or "G" out of a filename. By the time a string reaches
 * this file it is already known to be a grade, so the ambiguity is gone.
 */
const BUSINESS_GRADE_BASES: ReadonlySet<string> = new Set([
  'ms', 'bu', 'unc', 'gem', 'au', 'xf', 'ef', 'vf', 'vg', 'ag', 'fr', 'po', 'g', 'f'
]);

/** Every grade base we know, longest first so 'unc' is never read as 'u'. */
const BASES = [...GRADE_BASE_WORDS, 'g', 'f'].slice().sort((a, b) => b.length - a.length);

/** Adjectives in front of a grade, longest first ('nearly' before 'near'). */
const MODIFIERS = [...GRADE_MODIFIER_WORDS].slice().sort((a, b) => b.length - a.length);

/* ---------------------------------------------------------------------------
 * THE WORD PATTERNS
 * ------------------------------------------------------------------------- */

/**
 * THE PROOFLIKE FAMILY -- see the warning at the top of this file.
 *
 * Every one of these describes a BUSINESS STRIKE with mirrored fields:
 *
 *     PL      prooflike
 *     DMPL    deep mirror prooflike   (PCGS's spelling)
 *     DPL     deep prooflike          (NGC's spelling for the same thing)
 *
 * `[\s-]?` covers "prooflike", "proof like" and "proof-like" in one pattern.
 * "deep mirror" is listed on its own because a record sometimes writes the
 * designation out in full and drops the final word.
 *
 * A bare "PL" as a word is NOT in here on purpose: in a filename "PL" could be
 * Poland, a lot number or an initial. The PL designation reaches us through
 * the GRADE instead ("MS63PL"), where it is unambiguous -- and where the base
 * letters "MS" have already answered the question anyway.
 */
const PROOFLIKE_FAMILY = /\bproof[\s-]?like\b|\bdmpl\b|\bdpl\b|\bdeep[\s-]+mirror\b/i;

/**
 * The standalone word "proof".
 *
 * `\b` on the right already prevents a match inside "prooflike" (there is no
 * word boundary between "proof" and "like"), but "proof-like" and "proof like"
 * DO have one, so the lookahead rules those out too. Belt and braces: the
 * PROOFLIKE_FAMILY test above runs first in every caller.
 */
const PROOF_WORD = /\bproof\b(?![\s-]?like\b)/i;

/**
 * The same two patterns again, for a string that has already been through
 * `normalizeGrade` -- which lower-cases and deletes ALL whitespace, so
 * "MS63 PROOFLIKE" arrives as "ms63prooflike" with no word boundaries left to
 * anchor to. Substring matching is safe on a grade because a grade is a short
 * controlled string, not free text.
 */
const PROOFLIKE_IN_GRADE = /proof-?like|dmpl|dpl|deepmirror/;

/* ---------------------------------------------------------------------------
 * ENTRY POINT
 * ------------------------------------------------------------------------- */

/**
 * Work out how a coin was struck, from its grade and its descriptive text.
 *
 * Called with the FILENAME (extension stripped) on the image side, and with
 * the record's coin type + variety + notes on the inventory side, so both
 * sides of a comparison are read by the same rules.
 *
 * THREE QUESTIONS, IN THIS ORDER:
 *
 *   1. Does the GRADE say? "PF65RB" is a proof, "SP67" a specimen, "MS63" a
 *      business strike. Authoritative whenever it answers at all.
 *   2. Do the WORDS say? A standalone "proof" (never "prooflike").
 *   3. Neither said anything -- SO THE ANSWER IS 'business'. This is the
 *      owner's rule, verbatim:
 *
 *        "The Proof descriptor should always be part of the image file name
 *         as well as part of the inventory description otherwise it's assumed
 *         the coin is a business strike."
 *
 *      Step 3 is the whole of that sentence's second clause. It applies to
 *      BOTH sides, because he described both sides: the file name AND the
 *      inventory description.
 *
 * The one exception to step 3 is an input that is entirely empty, which is
 * not silence but absence -- see "WHEN 'unknown' CAN STILL HAPPEN" at the top
 * of this file.
 *
 * @param text  Free text that may describe the coin: a filename, or a record's
 *              type / variety / notes joined together. May be empty.
 * @param grade The grade from either side, raw or already normalized.
 */
export function detectStrike(text: unknown, grade: unknown): StrikeKind {
  // The grade speaks first and, when it says anything at all, it speaks last.
  const fromGrade = strikeFromGrade(grade);
  if (fromGrade !== 'unknown') return fromGrade;

  const fromText = strikeFromText(text);
  if (fromText !== 'unknown') return fromText;

  /* NOBODY SAID "PROOF" AND NOBODY SAID "SP", SO THIS IS A BUSINESS STRIKE.
   *
   * The guard below is the difference between SILENCE and ABSENCE, and it is
   * the only thing standing between 'unknown' and extinction:
   *
   *   SILENCE  a filename, or a record with a grade or some type text, that
   *            simply does not mention proof. He writes the designation
   *            whenever it applies, so not mentioning it is a statement.
   *            -> 'business'
   *
   *   ABSENCE  nothing was passed in at all: no text, no grade. There was no
   *            descriptor that COULD have carried the word, so there is no
   *            statement to read. -> 'unknown', which vetoes nothing.
   *
   * `strikeFromText` has already proved the text says nothing useful, so all
   * that is left to check is whether either input had any content. */
  const hasText = String(text ?? '').trim().length > 0;
  const hasGrade = String(grade ?? '').trim().length > 0;
  return hasText || hasGrade ? 'business' : 'unknown';
}

/**
 * The verdict carried by the grade's base letters, or 'unknown'.
 *
 * NOTE WHAT 'unknown' MEANS FROM THIS FUNCTION, because it is narrower than
 * what it means from `detectStrike`: it means "THE GRADE did not answer",
 * not "the coin's strike is undetermined". The owner's silence-means-business
 * rule is applied once, at the top in `detectStrike`, after BOTH sources have
 * been asked -- never here. Keeping this function a pure report of what the
 * grade states is what lets the text be consulted when the grade is blank.
 */
export function strikeFromGrade(raw: unknown): StrikeKind {
  const normalized = normalizeGrade(raw);
  if (!normalized) return 'unknown';

  /* THE TRAP, first: a grade field holding nothing but "PROOFLIKE" has no base
   * letters to read, and the bare-word test further down would call it a
   * proof. It is a business strike. (A grade WITH letters, "MS63 PROOFLIKE",
   * is answered the same way one line later by its "ms".) */
  if (PROOFLIKE_IN_GRADE.test(normalized)) return 'business';

  const base = leadingGradeBase(normalized);
  if (!base) return 'unknown';

  if (PROOF_GRADE_BASES.has(base)) return 'proof';
  if (SPECIMEN_GRADE_BASES.has(base)) return 'specimen';
  if (BUSINESS_GRADE_BASES.has(base)) return 'business';
  return 'unknown';
}

/**
 * The verdict carried by descriptive words, or 'unknown'.
 *
 * Same caveat as `strikeFromGrade`: 'unknown' here means "THESE WORDS did not
 * answer". It is `detectStrike` that turns an unanswered question into
 * 'business', and only after the grade has also been asked.
 */
export function strikeFromText(raw: unknown): StrikeKind {
  const text = String(raw ?? '');
  if (!text.trim()) return 'unknown';

  // THE TRAP, again and always: "prooflike" before "proof".
  if (PROOFLIKE_FAMILY.test(text)) return 'business';
  if (PROOF_WORD.test(text)) return 'proof';

  return 'unknown';
}

/**
 * The grade letters at the front of a normalized grade, with any leading
 * adjective skipped: "choicevf" -> "vf", "gembu" -> "bu", "ms63" -> "ms".
 *
 * A modifier is only skipped when a grade base follows it, so the bare word
 * "gem" (which is both an adjective and a grade in its own right) is still
 * read as the grade 'gem'. This mirrors `parseGradeParts` in near-match.ts;
 * the logic is repeated rather than shared because importing it would create
 * a cycle -- near-match.ts consults the vetoes, which consult this file.
 */
function leadingGradeBase(normalized: string): string | null {
  let rest = normalized;

  for (;;) {
    const modifier = MODIFIERS.find(
      m => rest.startsWith(m) && BASES.some(b => rest.slice(m.length).startsWith(b))
    );
    if (!modifier) break;
    rest = rest.slice(modifier.length);
  }

  return BASES.find(b => rest.startsWith(b)) ?? null;
}

/** Plain English for a strike, for the "why" sentences. */
export function strikeLabel(strike: StrikeKind): string {
  switch (strike) {
    case 'proof': return 'a proof';
    case 'business': return 'a business strike';
    case 'specimen': return 'a specimen strike';
    default: return 'not stated';
  }
}
