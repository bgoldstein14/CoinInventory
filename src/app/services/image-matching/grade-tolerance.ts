/*
 * Are these two grades the same grade? Shared by match-scorer.ts and
 * near-match.ts so both apply the same tolerance (PF65CAM = PF65 Cameo,
 * PR = PF, EF = XF). A leaf module to avoid an import cycle between them.
 */

import {
  GRADE_BASE_WORDS,
  GRADE_DESIGNATION_WORDS,
  GRADE_MODIFIER_WORDS
} from './filename-vocabulary';
import { normalizeGrade } from './grade-parser';

/*
 * The tolerance rule:
 *   same grade, more detail     MS64 vs MS64 CAC, AU58 vs AU58+, VF vs Choice VF
 *                               -> 'extra-detail'
 *   same grade, spelled differently
 *                               PF63CAM vs PF63 CAMEO, MS65 RD vs MS65 RED
 *                               -> 'exact'
 *   different grade             MS64 vs MS63, MS64 vs AU64, MS64 RB vs MS64 BN,
 *                               PF69 CAM vs PF69 DCAM -> 'different'
 *
 * Base letters and number must be identical after canonicalising; leftover
 * decorations may be added by one side only. If both sides carry something
 * the other lacks, they disagree.
 */

/**
 * Decorations meaning extra detail about the same grade that the filename
 * grade regex deliberately does not pick up (widening it there would swallow
 * non-grade words). Safe here because both inputs are already known grades,
 * e.g. filename "MS64" vs record "MS64 CAC".
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

/*
 * Equivalent spellings of one designation, mapped to a canonical token before
 * comparison so "63CAM" and "63 CAMEO" do not look contradictory.
 *
 * Two spellings share a group only if a grading service would print either
 * on the same slab. Stronger claims are separate groups:
 *   CAM < DCAM (UCAM is NGC's name for the top step); DCAM can be worth
 *   several times CAM. Copper colours RD / RB / BN are three different
 *   designations, not synonyms.
 *
 * `normalizeGrade` has already lower-cased the grade and removed whitespace,
 * but keeps hyphens not next to a digit (the range "XF-AU" needs them), so
 * spellings are written with spaces and expanded by `spellingVariants`.
 */

/** One designation, its spellings, and what it means. */
export interface GradeDesignationGroup {
  /** The single token every spelling in the group resolves to. */
  canonical: string;
  /** Spellings, written with SPACES between words (hyphens are generated). */
  spellings: readonly string[];
  /** Plain English, for the reader rather than the code. */
  meaning: string;
}

/** The synonym table. Separate groups are different claims about the coin. */
export const GRADE_DESIGNATION_SYNONYMS: readonly GradeDesignationGroup[] = [
  // Proof contrast, weakest to strongest.
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

  // Mirrored surfaces on a business strike (mostly Morgan dollars).
  {
    canonical: 'pl',
    spellings: ['pl', 'prooflike', 'proof like'],
    meaning: 'prooflike — mirrored fields on a circulation-strike coin'
  },
  {
    // DMPL (PCGS) and DPL (NGC) are the same step; distinct from plain PL.
    canonical: 'dmpl',
    spellings: ['dmpl', 'dpl', 'deep mirror prooflike', 'deep prooflike'],
    meaning: 'deep mirror prooflike — a stronger claim than plain prooflike'
  },

  // Copper colour: three distinct designations.
  { canonical: 'rd', spellings: ['rd', 'red'], meaning: 'full original mint red' },
  { canonical: 'rb', spellings: ['rb', 'red brown'], meaning: 'part red, part toned — NOT a kind of red' },
  { canonical: 'bn', spellings: ['bn', 'brown'], meaning: 'fully toned brown' },

  // Strike-completeness designations, one per coin series.
  { canonical: 'fb', spellings: ['fb', 'full bands'], meaning: 'full bands (Mercury dime)' },
  { canonical: 'fs', spellings: ['fs', 'full steps'], meaning: 'full steps (Jefferson nickel)' },
  { canonical: 'fh', spellings: ['fh', 'full head'], meaning: 'full head (Standing Liberty quarter)' },
  { canonical: 'ft', spellings: ['ft', 'full torch'], meaning: 'full torch (Roosevelt dime)' },
  { canonical: 'fbl', spellings: ['fbl', 'full bell lines'], meaning: 'full bell lines (Franklin half)' },
  { canonical: 'fsb', spellings: ['fsb', 'full split bands'], meaning: 'full split bands (Mercury dime)' },

  // Stickers and notes written into the grade field (CAC is often in the
  // record but not the filename).
  { canonical: 'cac', spellings: ['cac'], meaning: 'green CAC approval sticker' },
  { canonical: 'cacg', spellings: ['cacg'], meaning: 'CAC\'s own grading service' },
  { canonical: 'pq', spellings: ['pq'], meaning: 'premium quality for the grade' },
  { canonical: 'star', spellings: ['star'], meaning: 'NGC star — exceptional eye appeal' },
  { canonical: 'sms', spellings: ['sms'], meaning: 'special mint set strike' },
  {
    // From GRADE_DESIGNATION_WORDS; meaning unclear, so not folded into 'fbl'.
    canonical: 'bl', spellings: ['bl'], meaning: 'unexpanded; kept distinct on purpose'
  }
];

/**
 * Expand a spaced spelling into every no-separator/hyphen combination:
 * "red brown" -> ['redbrown', 'red-brown'].
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
 * Every recognised spelling -> its canonical token. Vocabulary words without
 * a synonym group map to themselves.
 */
const DECORATION_CANONICAL: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();

  for (const group of GRADE_DESIGNATION_SYNONYMS) {
    for (const spelling of group.spellings) {
      for (const variant of spellingVariants(spelling)) map.set(variant, group.canonical);
    }
  }
  for (const word of [...GRADE_DESIGNATION_WORDS, ...NEAR_MATCH_EXTRA_DESIGNATIONS]) {
    if (!map.has(word)) map.set(word, word);
  }

  return map;
})();

/**
 * Every recognised spelling, longest first, so 'cameo' is tried before 'cam'
 * and 'red-brown' before 'red'.
 */
const DECORATIONS = [...DECORATION_CANONICAL.keys()].sort((a, b) => b.length - a.length);

/**
 * Grade letters, longest first. Adds 'g' and 'f', which are safe here
 * because the input is already known to be a grade.
 */
const BASES = [...GRADE_BASE_WORDS, 'g', 'f'].slice().sort((a, b) => b.length - a.length);

/**
 * Grade letters that are two spellings of one grade: PR/PF (PCGS/NGC proof)
 * and EF/XF. UNC, BU and MS are not interchangeable, and SP is not PF.
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
  /** Same grade, nothing extra on either side (including respellings and reordering). */
  | 'exact'
  /** Same grade; one side says more about it. Still a near match. */
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
  /** Canonical letters, e.g. 'ms', 'pf' (for PR too), or a range 'xf-au'. */
  base: string;
  /** The number as written, or null when the grade has none ('VG', 'XF-AU'). */
  number: string | null;
  /** Canonical suffix decorations, e.g. ['dcam'], ['cac'], ['+']. */
  decorations: string[];
}

/**
 * Split a normalized grade ("ms64cac", "choicevf", "au58+", "xf-au") into its
 * parts, or return null when any of it is unrecognised (which makes the pair
 * 'different', the safe direction).
 */
export function parseGradeParts(normalized: string): GradeParts | null {
  let rest = normalized;
  if (!rest) return null;

  // Leading adjectives. Only strip one when a grade follows, so bare "gem" is
  // a grade while "gembu" is 'gem' + 'bu'.
  const modifiers: string[] = [];
  for (;;) {
    const modifier = MODIFIERS.find(m => rest.startsWith(m) && matchBase(rest.slice(m.length)));
    if (!modifier) break;
    modifiers.push(modifier);
    rest = rest.slice(modifier.length);
  }

  // Letters (optional: "63CAM" has none). An empty base only equals another
  // empty base, so "63" never matches "MS63".
  const first = matchBase(rest);
  let base = first ? canonicalBase(first) : '';
  if (first) rest = rest.slice(first.length);

  // A range ("XF-AU") is treated as one base, distinct from "XF".
  if (first && rest.startsWith('-')) {
    const second = matchBase(rest.slice(1));
    if (second) {
      base = `${base}-${canonicalBase(second)}`;
      rest = rest.slice(1 + second.length);
    }
  }

  // Number.
  const digits = /^\d{1,2}/.exec(rest);
  const number = digits ? digits[0] : null;
  if (digits) rest = rest.slice(digits[0].length);

  // Decorations, recorded in canonical form.
  const decorations: string[] = [];
  while (rest.length > 0) {
    if (rest[0] === '+' || rest[0] === '-') {
      decorations.push(rest[0]);
      rest = rest.slice(1);
      continue;
    }
    const decoration = DECORATIONS.find(d => rest.startsWith(d));
    if (!decoration) break;
    decorations.push(DECORATION_CANONICAL.get(decoration) ?? decoration);
    rest = rest.slice(decoration.length);
  }

  // Unrecognised leftovers: refuse. "MS64Details" is a problem coin, not an MS64.
  if (rest.length > 0) return null;

  // Decorations alone ("+", "cac") are not a grade.
  if (!base && number === null) return null;

  return { modifiers, base, number, decorations };
}

/** Longest-first prefix match against the grade letters. */
function matchBase(text: string): string | null {
  return BASES.find(b => text.startsWith(b)) ?? null;
}

/** Compare two grades, raw ("MS-63", "PF69 DCAM") or already normalized. */
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

  // Different numbers are different grades. A number on one side only
  // ("XF" vs "XF40") counts as extra detail.
  if (left.number !== null && right.number !== null && left.number !== right.number) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} and ${coin.toUpperCase()} are different numeric grades.`
    };
  }

  // Collect what each side says that the other does not.
  const leftExtras = new Set([...left.modifiers, ...left.decorations, ...(left.number !== null ? [left.number] : [])]);
  const rightExtras = new Set([...right.modifiers, ...right.decorations, ...(right.number !== null ? [right.number] : [])]);
  const onlyLeft = [...leftExtras].filter(x => !rightExtras.has(x));
  const onlyRight = [...rightExtras].filter(x => !leftExtras.has(x));

  // Both sides adding something is a contradiction (MS64 RB vs MS64 BN).
  if (onlyLeft.length > 0 && onlyRight.length > 0) {
    return {
      relation: 'different',
      extraDetail: [],
      description: `Grade ${file.toUpperCase()} and ${coin.toUpperCase()} each say something the other contradicts.`
    };
  }

  // Only spelling or order differed ("PF63CAM" vs "PF63 CAMEO").
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
