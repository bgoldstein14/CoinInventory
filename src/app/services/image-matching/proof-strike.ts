 /*
 * Decides how a coin was struck: proof, business strike, specimen, or unknown.
 * `detectStrike` is applied to both the filename and the coin record so both
 * sides are judged by the same rules. A strike disagreement is a hard veto
 * (match-vetoes.ts): a proof and a business strike of the same date are
 * different coins.
 *
 * Prooflike is NOT proof. PL, DMPL, DPL and "prooflike" describe a business
 * strike with mirrored fields (common on Morgan dollars). A naive
 * `includes('proof')` would veto those against their own records, so
 * PROOFLIKE_FAMILY is always checked before the bare word "proof".
 *
 * Evidence, in order:
 *   1. Grade letters, authoritative when present:
 *        PF / PR -> proof, SP -> specimen, MS/BU/UNC/AU/XF/VF/... -> business.
 *   2. A standalone "proof" in the filename or record text.
 *   3. Neither -> 'business'. The collection always writes the proof/specimen
 *      designation when it applies, so silence means business strike. This
 *      applies to strike only; other attributes treat absence as unknown.
 *   'unknown' is returned only when both text and grade are empty, and vetoes
 *   nothing.
 *
 * This is separate from grade comparison because `compareGrades` reports
 * 'missing' whenever one side lacks a grade (so it can't express the
 * silence rule) and never sees "proof" in descriptive text. Strike letters are
 * a fact and veto; the grade number is a judgement and is only scored.
  */

import { StrikeKind } from '../../types/coin.model';
import {
  GRADE_BASE_WORDS,
  GRADE_MODIFIER_WORDS
} from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';

/** Grade letters that only ever appear on a PROOF slab. */
const PROOF_GRADE_BASES: ReadonlySet<string> = new Set(['pf', 'pr']);

/** Grade letters that only ever appear on a SPECIMEN slab. */
const SPECIMEN_GRADE_BASES: ReadonlySet<string> = new Set(['sp']);

/**
 * Grade letters that only appear on a business strike (a worn proof is graded
 * "PF55", not "AU55"). Lone 'g' and 'f' are fine here because the input is
 * already known to be a grade.
 */
const BUSINESS_GRADE_BASES: ReadonlySet<string> = new Set([
  'ms', 'bu', 'unc', 'gem', 'au', 'xf', 'ef', 'vf', 'vg', 'ag', 'fr', 'po', 'g', 'f'
]);

/** Every grade base we know, longest first so 'unc' is never read as 'u'. */
const BASES = [...GRADE_BASE_WORDS, 'g', 'f'].slice().sort((a, b) => b.length - a.length);

/** Adjectives in front of a grade, longest first ('nearly' before 'near'). */
const MODIFIERS = [...GRADE_MODIFIER_WORDS].slice().sort((a, b) => b.length - a.length);

/**
 * The prooflike family: business strikes with mirrored fields.
 *   PL = prooflike, DMPL = deep mirror prooflike (PCGS), DPL = deep prooflike (NGC).
 * A bare "PL" word is excluded because in a filename it could mean anything;
 * PL arrives via the grade ("MS63PL") instead.
 */
const PROOFLIKE_FAMILY = /\bproof[\s-]?like\b|\bdmpl\b|\bdpl\b|\bdeep[\s-]+mirror\b/i;

/**
 * The standalone word "proof". The lookahead excludes "proof like" and
 * "proof-like"; PROOFLIKE_FAMILY is also checked first in every caller.
 */
const PROOF_WORD = /\bproof\b(?![\s-]?like\b)/i;

/**
 * Prooflike patterns for a string already through `normalizeGrade`, which
 * strips whitespace and so leaves no word boundaries ("ms63prooflike").
 */
const PROOFLIKE_IN_GRADE = /proof-?like|dmpl|dpl|deepmirror/;

/**
 * Work out how a coin was struck, from its grade and descriptive text
 * (the filename, or a record's coin type + variety + notes).
 *
 * @param text  Free text describing the coin. May be empty.
 * @param grade The grade, raw or already normalized.
 */
export function detectStrike(text: unknown, grade: unknown): StrikeKind {
  // The grade speaks first and, when it says anything at all, it speaks last.
  const fromGrade = strikeFromGrade(grade);
  if (fromGrade !== 'unknown') return fromGrade;

  const fromText = strikeFromText(text);
  if (fromText !== 'unknown') return fromText;

  // Silence means business strike; only fully empty input stays 'unknown'.
  const hasText = String(text ?? '').trim().length > 0;
  const hasGrade = String(grade ?? '').trim().length > 0;
  return hasText || hasGrade ? 'business' : 'unknown';
}

/**
 * The verdict carried by the grade's base letters, or 'unknown' if the grade
 * doesn't answer. The silence-means-business rule is applied in `detectStrike`.
 */
export function strikeFromGrade(raw: unknown): StrikeKind {
  const normalized = normalizeGrade(raw);
  if (!normalized) return 'unknown';

  // A bare "PROOFLIKE" grade has no base letters; it is a business strike.
  if (PROOFLIKE_IN_GRADE.test(normalized)) return 'business';

  const base = leadingGradeBase(normalized);
  if (!base) return 'unknown';

  if (PROOF_GRADE_BASES.has(base)) return 'proof';
  if (SPECIMEN_GRADE_BASES.has(base)) return 'specimen';
  if (BUSINESS_GRADE_BASES.has(base)) return 'business';
  return 'unknown';
}

/** The verdict carried by descriptive words, or 'unknown' if they say nothing. */
export function strikeFromText(raw: unknown): StrikeKind {
  const text = String(raw ?? '');
  if (!text.trim()) return 'unknown';

  // THE TRAP, again and always: "prooflike" before "proof".
  if (PROOFLIKE_FAMILY.test(text)) return 'business';
  if (PROOF_WORD.test(text)) return 'proof';

  return 'unknown';
}

/**
 * The grade letters at the front of a normalized grade, skipping a leading
 * adjective: "choicevf" -> "vf", "gembu" -> "bu", "ms63" -> "ms". A bare "gem"
 * is still read as a grade. Duplicates `parseGradeParts` in near-match.ts
 * because importing it would create a cycle.
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
