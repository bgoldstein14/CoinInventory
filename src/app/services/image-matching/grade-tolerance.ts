/* ===========================================================================
 * grade-tolerance.ts
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE OWNS
 *   ONE QUESTION, ASKED IN ONE PLACE: are these two grades the same grade?
 *
 *     `compareGrades`     the answer, as a GradeComparison.
 *     `parseGradeParts`   the split into modifiers / letters / number /
 *                         decorations that `compareGrades` compares.
 *     the tables          GRADE_DESIGNATION_SYNONYMS (CAM = CAMEO, PL =
 *                         PROOFLIKE, ...) and BASE_SYNONYMS (PR = PF,
 *                         EF = XF), which are what make the answer tolerant.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE NOW -- AND WHY IT WAS MOVED RATHER THAN COPIED
 * ---------------------------------------------------------------------------
 *   All of this used to live in near-match.ts, where only the tier-2
 *   four-attribute test could reach it. match-scorer.ts, which does the
 *   actual comparing, still measured grade agreement with a plain `===`.
 *
 *   The owner measured the consequence himself. These two files are
 *   PHOTOGRAPHS OF ONE COIN:
 *
 *       1867 3CS - NGC PF65CAM - Reverse.jpg       scored 0.84 -> skipped
 *       1867 3CS - NGC PF65 Cameo - Obverse.jpg    scored 0.88 -> attached
 *
 *   His record for that coin reads "1867 3CS - NGC PF65 Cameo". One photo
 *   abbreviates the designation and the other spells it out, and that alone
 *   moved the score by 0.03 -- which happens to be exactly the distance
 *   across the 0.85 auto-match bar. Half his Early Proofs collection is in
 *   the same position: he writes PR where PCGS prints it and PF where NGC
 *   does ("1868 3CS - PCGS PR65" beside "1865 3CS - PCGS PF64"), and CAM
 *   where one slab says CAM and another says Cameo.
 *
 *   His rule, verbatim, and the one this file exists to apply EVERYWHERE:
 *
 *       "Keep in mind that the grade might slightly differ and still be
 *        correct like 63CAM or 63 CAMEO or 63PL of 63 PL or something like
 *        that."
 *
 *   The fix could have been to copy the comparison into the scorer. It was
 *   not, deliberately. TWO IMPLEMENTATIONS OF "ARE THESE THE SAME GRADE?"
 *   WOULD DRIFT, and the day they drifted the scorer would be rewarding a
 *   pairing that the near-match test refuses, or the reverse -- which is the
 *   precise class of bug this whole directory has spent its life chasing
 *   (see the header of match-vetoes.ts for the same argument about year and
 *   denomination conflicts). So the code MOVED here, to a leaf module that
 *   imports nothing but the vocabulary and the normalizer, and both callers
 *   now read the one answer:
 *
 *       match-scorer.ts   scoring the grade attribute of one pair
 *       near-match.ts     the four-attribute tier-2 test
 *
 *   It had to be a NEW FILE rather than a function left in near-match.ts,
 *   because near-match.ts imports match-scorer.ts (for `diceSimilarity`), so
 *   the scorer importing near-match.ts would have made the two files import
 *   each other in a circle. near-match.ts re-exports everything below so
 *   that `import { compareGrades } from './near-match'` keeps working, the
 *   same way match-scorer.ts re-exports `formatYear`.
 * =========================================================================== */

import {
  GRADE_BASE_WORDS,
  GRADE_DESIGNATION_WORDS,
  GRADE_MODIFIER_WORDS
} from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';

/* ===========================================================================
 * THE GRADE TOLERANCE
 * ---------------------------------------------------------------------------
 * The product owner's words, verbatim:
 *
 *   "...although something about the grade is a little off like there's extra
 *    information then that might be acceptable as a near-match"
 *
 * So the rule is NOT "grades are roughly similar". It is much narrower:
 *
 *   SAME GRADE, MORE DETAIL  -> still a near match
 *       MS64        vs  MS64 CAC       (a CAC sticker was noted on one side)
 *       PF69        vs  PF69DCAM       (deep cameo noted on one side)
 *       AU58        vs  AU58+          (the plus noted on one side)
 *       VF          vs  Choice VF      (the adjective noted on one side)
 *
 *   SAME GRADE, SPELLED DIFFERENTLY -> the same grade, full stop
 *       PF63CAM     vs  PF63 CAMEO     one abbreviates what the other spells
 *       MS64PL      vs  MS64 PROOFLIKE out; nothing about the coin differs
 *       MS65 RD     vs  MS65 RED
 *   See GRADE_DESIGNATION_SYNONYMS below. This case used to be refused, which
 *   is the bug that table exists to fix.
 *
 *   A DIFFERENT GRADE        -> NOT a near match, ever
 *       MS64        vs  MS63           different number  = a different coin
 *       MS64        vs  AU64           different letters = a different coin
 *       MS64 RB     vs  MS64 BN        red-brown vs brown; each side carries
 *                                      detail that CONTRADICTS the other
 *       PF69 CAM    vs  PF69 DCAM      cameo is not deep cameo -- an abbrev-
 *                                      iation that merely LOOKS similar is
 *                                      still a different designation
 *
 * The distinction that does all the work: the base letters and the numeric
 * part must be IDENTICAL ONCE BOTH SIDES ARE CANONICALISED, and the leftover
 * decorations may only be added by ONE side. If both sides carry a decoration
 * the other lacks, they disagree and we refuse.
 *
 * All the vocabulary is reused from filename-vocabulary.ts / grade-parser.ts
 * rather than re-invented here; see NEAR_MATCH_EXTRA_DESIGNATIONS for the one
 * short list this file has to add, and why.
 * ========================================================================= */

/**
 * Decorations that mean "extra information about the SAME grade" but which
 * grade-parser.ts deliberately does not recognise when reading a FILENAME.
 *
 * Why they are listed here and not added to GRADE_DESIGNATION_WORDS: that list
 * feeds a regex that has to pull a grade out of free-text filenames, and
 * widening it risks swallowing words that are not grade designations at all.
 * Here we are comparing two strings that are ALREADY known to be grades, so
 * recognising more suffixes is safe. The practical consequence is pleasant:
 * a filename "1933 $20 MS64 CAC.jpg" parses to just "ms64" (the filename regex
 * stops at the number), while the coin record's grade field holds "MS64 CAC"
 * and normalizes to "ms64cac" -- and this list is what lets those two be
 * recognised as the same grade with extra detail.
 */
export const NEAR_MATCH_EXTRA_DESIGNATIONS: readonly string[] = [
  'cac',    // the green CAC sticker, written into the grade field by hand
  'cacg',   // CAC's own grading service
  'pq',     // "premium quality"
  'dmpl',   // deep mirror prooflike (GRADE_DESIGNATION_WORDS has 'dpl'/'pl')
  'fbl',    // full bell lines
  'fsb',    // full split bands
  'ft',     // full torch (Roosevelt dimes)
  'sms'     // special mint set
];

/* ===========================================================================
 * EQUIVALENT SPELLINGS OF THE SAME DESIGNATION
 * ---------------------------------------------------------------------------
 * The product owner's words, verbatim:
 *
 *   "Keep in mind that the grade might slightly differ and still be correct
 *    like 63CAM or 63 CAMEO or 63PL of 63 PL or something like that."
 *
 * WHAT WAS GOING WRONG
 *   The tolerance rule below compares the leftover decorations as plain
 *   strings. "63CAM" yields the decoration 'cam'; "63 CAMEO" yields 'cameo'.
 *   Neither side's token appears on the other, so the rule concluded that each
 *   side said something the other CONTRADICTED -- and threw away a pair that
 *   is, in fact, the identical grade written two ways. Worse, a spelled-out
 *   "PROOFLIKE" was not in the vocabulary at all, so the whole grade failed to
 *   parse and was refused outright.
 *
 * THE FIX
 *   Every spelling of a designation is mapped to ONE canonical token before
 *   anything is compared. 'cam' and 'cameo' both become 'cam', so the two
 *   sides hold the same token and the grades agree.
 *
 * ---------------------------------------------------------------------------
 * WHY 'CAM' AND 'CAMEO' ARE THE SAME THING BUT 'CAM' AND 'DCAM' ARE NOT
 * ---------------------------------------------------------------------------
 *   A future reader will not know the numismatics, so: these suffixes describe
 *   how a PROOF coin's frosted design contrasts with its mirrored field.
 *
 *     CAM  / CAMEO        -- the contrast is present.
 *     DCAM / DEEP CAMEO   -- the contrast is strong, on BOTH sides, and holds
 *                            up over a run of strikes.
 *     UCAM / ULTRA CAMEO  -- NGC's name for the same top step DCAM describes.
 *
 *   "CAM" and "CAMEO" are the SAME DESIGNATION: one is PCGS's abbreviation and
 *   the other is the word it abbreviates. Nothing about the coin differs.
 *
 *   "CAM" and "DCAM" are DIFFERENT DESIGNATIONS, and the difference is worth
 *   real money -- a 1960s proof in DCAM can be worth several times the same
 *   coin in plain CAM. They share three letters, and that is all they share.
 *   Collapsing them would quietly offer the user the wrong coin.
 *
 *   The same discipline applies to the copper colour codes, which form a
 *   hierarchy rather than a set of synonyms:
 *     RD / RED          -- full original mint red.
 *     RB / RED-BROWN    -- part red, part toned. A DIFFERENT coin from RD.
 *     BN / BROWN        -- fully toned. A DIFFERENT coin from both.
 *   "RED-BROWN" is not "a kind of RED"; it is its own grade designation, and
 *   there is an existing test (MS64RB vs MS64BN) guarding exactly that.
 *
 *   RULE OF THUMB for anyone extending the table: two entries belong in the
 *   same group only when a grading service would print either one on the same
 *   slab. If one is a stronger claim than the other, they are two groups.
 *
 * ---------------------------------------------------------------------------
 * SPACING, HYPHENATION AND CASE
 * ---------------------------------------------------------------------------
 *   `normalizeGrade` has already lower-cased the string and removed ALL
 *   whitespace by the time we see it, so "63 PL" and "63PL" are literally the
 *   same string here and no synonym entry is needed for the space. Hyphens are
 *   a different story: normalizeGrade only strips the ones sitting next to a
 *   digit (so "MS-63" and "PF69-DCAM" are handled) because the hyphen in the
 *   RANGE grade "XF-AU" is meaningful and must survive. A hyphen INSIDE a
 *   written-out designation ("RED-BROWN", "DEEP-CAMEO") therefore reaches us
 *   intact, which is why the spellings below are written with spaces and then
 *   expanded into every space/hyphen combination -- see `spellingVariants`.
 * ========================================================================= */

/** One designation, all the ways this trade writes it, and what it means. */
export interface GradeDesignationGroup {
  /** The single token every spelling in the group resolves to. */
  canonical: string;
  /** Spellings, written with SPACES between words (hyphens are generated). */
  spellings: readonly string[];
  /** Plain English, for the reader rather than the code. */
  meaning: string;
}

/**
 * The synonym table. Each group is one designation; separate groups are
 * genuinely different claims about the coin and must never be merged.
 */
export const GRADE_DESIGNATION_SYNONYMS: readonly GradeDesignationGroup[] = [
  /* -- proof contrast, weakest to strongest. Three SEPARATE groups. ------- */
  { canonical: 'cam', spellings: ['cam', 'cameo'], meaning: 'cameo contrast' },
  {
    canonical: 'dcam',
    spellings: ['dcam', 'dcameo', 'deep cameo', 'dc'],
    meaning: 'deep cameo contrast — a stronger claim than plain cameo'
  },
  {
    canonical: 'ucam',
    spellings: ['ucam', 'ucameo', 'ultra cameo'],
    meaning: 'ultra cameo — NGC\'s name for the top contrast step'
  },

  /* -- mirrored surfaces on a BUSINESS strike (mostly Morgan dollars) ----- */
  {
    canonical: 'pl',
    spellings: ['pl', 'prooflike', 'proof like'],
    meaning: 'prooflike — mirrored fields on a circulation-strike coin'
  },
  {
    /* DMPL is PCGS's spelling and DPL is NGC's; both name the same, deeper
     * step above plain PL, so they share a group. CONFIRMED BY THE OWNER on
     * 2026-10-17, when asked directly whether he distinguishes them: "They are
     * the same." Recorded here because the two services' wording differs
     * enough to invite someone to split this group later; do not, without
     * asking him again.
     *
     * They are NOT merged into 'pl' -- a DMPL Morgan is a different (and far
     * dearer) coin than a PL. */
    canonical: 'dmpl',
    spellings: ['dmpl', 'dpl', 'deep mirror prooflike', 'deep prooflike'],
    meaning: 'deep mirror prooflike — a stronger claim than plain prooflike'
  },

  /* -- copper colour. A HIERARCHY: three groups, never merged. ------------ */
  { canonical: 'rd', spellings: ['rd', 'red'], meaning: 'full original mint red' },
  { canonical: 'rb', spellings: ['rb', 'red brown'], meaning: 'part red, part toned — NOT a kind of red' },
  { canonical: 'bn', spellings: ['bn', 'brown'], meaning: 'fully toned brown' },

  /* -- strike-completeness designations, one per coin series -------------- */
  { canonical: 'fb', spellings: ['fb', 'full bands'], meaning: 'full bands (Mercury dime)' },
  { canonical: 'fs', spellings: ['fs', 'full steps'], meaning: 'full steps (Jefferson nickel)' },
  { canonical: 'fh', spellings: ['fh', 'full head'], meaning: 'full head (Standing Liberty quarter)' },
  { canonical: 'ft', spellings: ['ft', 'full torch'], meaning: 'full torch (Roosevelt dime)' },
  { canonical: 'fbl', spellings: ['fbl', 'full bell lines'], meaning: 'full bell lines (Franklin half)' },
  { canonical: 'fsb', spellings: ['fsb', 'full split bands'], meaning: 'full split bands (Mercury dime)' },

  /* -- stickers, labels and other notes written into the grade field ------
   * CAC is the one the owner called out by name: "CAC might be missing on the
   * picture but it's in the inventory." It needs no synonyms, but it is listed
   * here so the table is the single place every decoration is declared. */
  { canonical: 'cac', spellings: ['cac'], meaning: 'green CAC approval sticker' },
  { canonical: 'cacg', spellings: ['cacg'], meaning: 'CAC\'s own grading service' },
  { canonical: 'pq', spellings: ['pq'], meaning: 'premium quality for the grade' },
  { canonical: 'star', spellings: ['star'], meaning: 'NGC star — exceptional eye appeal' },
  { canonical: 'sms', spellings: ['sms'], meaning: 'special mint set strike' },
  {
    /* 'bl' comes from the existing GRADE_DESIGNATION_WORDS list. It is left on
     * its own deliberately: it is not clear enough what it abbreviates to risk
     * folding it into 'fbl' (full BELL lines) or anything else. When in doubt,
     * a designation keeps its own group -- the cost is a missed near match,
     * which is far cheaper than a wrong one. */
    canonical: 'bl', spellings: ['bl'], meaning: 'unexpanded; kept distinct on purpose'
  }
];

/**
 * Expand one spelling into every space/hyphen combination it could be written
 * with. "red brown" -> ['redbrown', 'red-brown']; "deep mirror prooflike" ->
 * all four combinations. Whitespace is already gone by the time a grade
 * reaches us, so the no-separator form is what a spaced spelling collapses to.
 */
function spellingVariants(spelling: string): string[] {
  const words = spelling.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const variants: string[] = [];
  const walk = (index: number, built: string): void => {
    if (index === words.length) {
      variants.push(built);
      return;
    }
    for (const joiner of ['', '-']) walk(index + 1, built + joiner + words[index]);
  };
  walk(1, words[0]);

  return variants;
}

/**
 * Every recognised spelling -> its canonical token.
 *
 * Built once at module load. The designation words grade-parser.ts already
 * knows about are folded in at the end as their own canonical tokens, so a
 * word added to GRADE_DESIGNATION_WORDS still parses here even if nobody
 * remembers to give it a synonym group.
 */
const DECORATION_CANONICAL: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();

  for (const group of GRADE_DESIGNATION_SYNONYMS) {
    for (const spelling of group.spellings) {
      for (const variant of spellingVariants(spelling)) map.set(variant, group.canonical);
    }
  }
  // Safety net: anything the shared vocabulary knows but the table above has
  // not claimed stands for itself rather than vanishing.
  for (const word of [...GRADE_DESIGNATION_WORDS, ...NEAR_MATCH_EXTRA_DESIGNATIONS]) {
    if (!map.has(word)) map.set(word, word);
  }

  return map;
})();

/**
 * Every recognised spelling, LONGEST FIRST.
 *
 * The order is load-bearing, twice over: 'cameo' must be tried before 'cam'
 * (or "63cameo" reads as cameo plus a leftover "eo" and the whole grade is
 * refused), and 'red-brown' must be tried before 'red' (or "MS64 Red-Brown"
 * reads as RED followed by BROWN -- two contradicting colour codes instead of
 * the one designation RB).
 */
const DECORATIONS = [...DECORATION_CANONICAL.keys()].sort((a, b) => b.length - a.length);

/**
 * Grade letters. GRADE_BASE_WORDS plus the two single letters that
 * grade-parser.ts accepts only in narrow shapes -- by the time a string
 * reaches us it is already known to be a grade, so 'g' and 'f' are safe here.
 * Longest first so 'unc' is never read as 'u' + leftover.
 */
const BASES = [...GRADE_BASE_WORDS, 'g', 'f'].slice().sort((a, b) => b.length - a.length);

/**
 * Grade LETTERS that are two spellings of one thing.
 *
 * Only two, and both are beyond dispute:
 *   PR / PF  -- "Proof". PCGS prints PR, NGC prints PF. Same grade, same coin.
 *   EF / XF  -- "Extremely Fine". EF is the older (and British) spelling of
 *               the grade American catalogues print as XF.
 *
 * Nothing else belongs here. In particular UNC, BU and MS are deliberately
 * left apart: they overlap in meaning but they are not interchangeable
 * notations, and SP (Specimen) is a different striking from PF altogether.
 */
const BASE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['pr', 'pf'],
  ['ef', 'xf']
]);

/** Fold one set of grade letters onto its canonical spelling. */
function canonicalBase(letters: string): string {
  return BASE_SYNONYMS.get(letters) ?? letters;
}

/** Adjectives in front of a grade, longest first ('nearly' before 'near'). */
const MODIFIERS = [...GRADE_MODIFIER_WORDS].slice().sort((a, b) => b.length - a.length);

/** How two grades relate to one another. */
export type GradeRelation =
  /**
   * The same grade, with nothing extra on either side. Usually
   * character-for-character identical, but also covers two spellings of one
   * grade ("PF63CAM" / "PF63 CAMEO") and the same decorations in a different
   * order ("MS64 CAC PQ" / "MS64 PQ CAC").
   */
  | 'exact'
  /** The same grade; one side simply says more about it. Still a near match. */
  | 'extra-detail'
  /** A different grade, or two decorations that contradict. Never a near match. */
  | 'different'
  /** One side (or both) has no grade at all. Never a near match. */
  | 'missing';

/** The outcome of comparing one filename's grade with one coin's grade. */
export interface GradeComparison {
  relation: GradeRelation;
  /** The decorations only one side carried, e.g. ['cac']. */
  extraDetail: string[];
  /** One sentence fit to show the user. */
  description: string;
}

/** A grade broken into the parts the tolerance rule compares. */
interface GradeParts {
  /** Adjectives in front, e.g. ['choice']. */
  modifiers: string[];
  /**
   * The letters in CANONICAL form, e.g. 'ms', 'vf', or the whole range
   * 'xf-au'. "PR69" and "PF69" both report base 'pf'; see BASE_SYNONYMS.
   */
  base: string;
  /** The number as written, or null when the grade has none ('VG', 'XF-AU'). */
  number: string | null;
  /**
   * Suffix decorations in CANONICAL form, e.g. ['dcam'], ['cac'], ['+'].
   * "63CAM" and "63 CAMEO" both report ['cam'], which is what lets the
   * comparison below see them as one grade; see GRADE_DESIGNATION_SYNONYMS.
   */
  decorations: string[];
}

/**
 * Split a NORMALIZED grade ("ms64cac", "choicevf", "au58+", "xf-au") into its
 * parts, or return null when any of it is unrecognised.
 *
 * Returning null is the safe answer, not a failure: an unrecognised grade can
 * never be declared "the same grade with extra detail", so the pair simply is
 * not a near match and the image lands in the read-only tier. That is the
 * direction we want to be wrong in.
 */
export function parseGradeParts(normalized: string): GradeParts | null {
  let rest = normalized;
  if (!rest) return null;

  // -- leading adjectives -------------------------------------------------
  // Only strip a modifier when what FOLLOWS it is a grade, so the bare word
  // "gem" (which is both a modifier and a grade in its own right) is read as
  // the grade, while "gembu" is read as the modifier 'gem' plus the grade 'bu'.
  const modifiers: string[] = [];
  for (;;) {
    const modifier = MODIFIERS.find(m => rest.startsWith(m) && matchBase(rest.slice(m.length)));
    if (!modifier) break;
    modifiers.push(modifier);
    rest = rest.slice(modifier.length);
  }

  // -- the letters --------------------------------------------------------
  /* The letters may be ABSENT. The owner writes grades in conversation as
   * "63CAM" / "63 CAMEO", and a hand-typed record sometimes holds just the
   * number too. An empty base is a perfectly good thing to compare -- it only
   * ever equals another empty base, so a bare "63" still never matches an
   * "MS63"; it just lets "63CAM" and "63 CAMEO" be recognised as one grade.
   * A string with NEITHER letters nor a number is rejected further down. */
  const first = matchBase(rest);
  // Folded onto one spelling so "PR69" and "PF69" compare as the same grade.
  let base = first ? canonicalBase(first) : '';
  if (first) rest = rest.slice(first.length);

  // A RANGE keeps its hyphen ("XF-AU"), because normalizeGrade only strips the
  // hyphens that sit next to a digit. Treat the whole range as the base: "XF"
  // and "XF-AU" are genuinely different statements about a coin. Both halves
  // are folded, so "EF-AU" and "XF-AU" are one grade. (Only reachable when
  // there WERE leading letters -- a bare number cannot open a range.)
  if (first && rest.startsWith('-')) {
    const second = matchBase(rest.slice(1));
    if (second) {
      base = `${base}-${canonicalBase(second)}`;
      rest = rest.slice(1 + second.length);
    }
  }

  // -- the number ---------------------------------------------------------
  const digits = /^\d{1,2}/.exec(rest);
  const number = digits ? digits[0] : null;
  if (digits) rest = rest.slice(digits[0].length);

  // -- the decorations ----------------------------------------------------
  const decorations: string[] = [];
  while (rest.length > 0) {
    if (rest[0] === '+' || rest[0] === '-') {
      decorations.push(rest[0]);
      rest = rest.slice(1);
      continue;
    }
    const decoration = DECORATIONS.find(d => rest.startsWith(d));
    if (!decoration) break;
    /* Record the CANONICAL token, not the spelling we happened to find, so
     * "63CAM" and "63 CAMEO" both leave 'cam' behind and the comparison below
     * sees one designation rather than two contradicting ones. */
    decorations.push(DECORATION_CANONICAL.get(decoration) ?? decoration);
    rest = rest.slice(decoration.length);
  }

  // Anything still left is something we do not understand. Refuse rather than
  // guess: "MS64Details" is a PROBLEM coin, not an MS64 with a footnote, and
  // quietly treating leftovers as harmless decoration is how that mistake gets
  // made.
  if (rest.length > 0) return null;

  // Letters or a number -- something has to identify the grade. A string of
  // nothing but decorations ("+", "cac") is not a grade and must not be
  // treated as one.
  if (!base && number === null) return null;

  return { modifiers, base, number, decorations };
}

/** Longest-first prefix match against the grade letters. */
function matchBase(text: string): string | null {
  return BASES.find(b => text.startsWith(b)) ?? null;
}

/**
 * The grade tolerance, as one function.
 *
 * Both arguments may be raw ("MS-63", "PF69 DCAM") or already normalized; they
 * are put through `normalizeGrade` either way so the filename side and the
 * record side are spelled the same before anything is compared.
 */
export function compareGrades(fileGrade: unknown, coinGrade: unknown): GradeComparison {
  const file = normalizeGrade(fileGrade);
  const coin = normalizeGrade(coinGrade);

  if (!file && !coin) {
    return { relation: 'missing', extraDetail: [], description: 'Neither the filename nor the coin record gives a grade.' };
  }
  if (!file) {
    return { relation: 'missing', extraDetail: [], description: 'The filename does not give a grade.' };
  }
  if (!coin) {
    return { relation: 'missing', extraDetail: [], description: 'The coin record does not give a grade.' };
  }

  if (file === coin) {
    return { relation: 'exact', extraDetail: [], description: `Grade ${file.toUpperCase()} matches exactly.` };
  }

  const left = parseGradeParts(file);
  const right = parseGradeParts(coin);
  if (!left || !right) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grades ${file.toUpperCase()} and ${coin.toUpperCase()} could not be compared, so they are treated as different.`
    };
  }

  // Different letters, or a range on one side only, is a different grade.
  if (left.base !== right.base) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} is not the same grade as ${coin.toUpperCase()}.`
    };
  }

  /* The number is the line the owner drew: "MS64 vs MS63 is a different coin".
   * A number present on one side only is treated as extra DETAIL rather than a
   * contradiction -- "XF" and "XF40" are the same grade, one simply stated
   * more precisely. That still only ever produces a near match, which the user
   * must confirm; it never attaches anything. */
  if (left.number !== null && right.number !== null && left.number !== right.number) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} and ${coin.toUpperCase()} are different numeric grades.`
    };
  }

  // Everything that is left over is decoration. Collect what each side says
  // that the other does not.
  const leftExtras = new Set([...left.modifiers, ...left.decorations, ...(left.number !== null ? [left.number] : [])]);
  const rightExtras = new Set([...right.modifiers, ...right.decorations, ...(right.number !== null ? [right.number] : [])]);
  const onlyLeft = [...leftExtras].filter(x => !rightExtras.has(x));
  const onlyRight = [...rightExtras].filter(x => !leftExtras.has(x));

  /* BOTH sides carrying something the other lacks is a disagreement, not extra
   * information: "MS64 RB" against "MS64 BN" is red-brown against brown, which
   * are two different coins however similar the strings look. */
  if (onlyLeft.length > 0 && onlyRight.length > 0) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} and ${coin.toUpperCase()} each say something the other contradicts.`
    };
  }

  /* NEITHER side has anything the other lacks, yet the two strings differ.
   * That means the only difference was in the SPELLING -- "PF63CAM" against
   * "PF63 CAMEO", or the same decorations written in a different order. There
   * is nothing extra to tell the user about, so report it as what it is: the
   * same grade. (This is reached only when the two raw strings were unequal;
   * an identical pair was already answered as 'exact' further up.) */
  if (onlyLeft.length === 0 && onlyRight.length === 0) {
    return {
      relation: 'exact',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} and ${coin.toUpperCase()} are the same grade written two ways.`
    };
  }

  const extraDetail = onlyLeft.length > 0 ? onlyLeft : onlyRight;
  const richer = onlyLeft.length > 0 ? 'filename' : 'coin record';
  return {
    relation: 'extra-detail',
    extraDetail,
    description:
      `Same grade with extra detail: the ${richer} writes it ` +
      `${(onlyLeft.length > 0 ? file : coin).toUpperCase()} and the other side writes it ` +
      `${(onlyLeft.length > 0 ? coin : file).toUpperCase()}.`
  };
}
