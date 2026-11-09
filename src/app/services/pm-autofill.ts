 /*
 * pm-autofill.ts — FILLING IN METAL AND WEIGHT WHILE THE USER TYPES A COIN
 *
 * THE RULE THIS IMPLEMENTS
 *
 * When a coin is added or edited by hand, the alloy and weight fields should
 * fill themselves in once there is enough to go on. Blanks are filled
 * silently; a key-field change re-runs the inference and prompts before
 * overwriting anything that would come out different.
 *
 * ---- THE CONSTRAINTS THAT MAKE THIS SAFE — DO NOT RELAX THEM ----
 *   * THE TRIGGER IS A COMMIT, NOT A KEYSTROKE AND NOT A TIMER. The editor
 *     calls this from the native `change` event of the key control — the
 *     event a text box fires when it loses focus (or on Enter) AND the value
 *     actually changed — and from a <select>'s own change. The caret has left
 *     the box by then. A debounce-timer design fires mid-word; nothing here
 *     is on a clock.
 *
 *   * THERE IS DELIBERATELY NO `effect()` OVER THE COIN SIGNAL anywhere in
 *     this feature. A derivation over that signal re-runs on every single
 *     keystroke, because the signal gets a new identity on each edit; that is
 *     the trap documented at length in
 *     components/coin-editor-form/custom-option-mode.ts, where a text box was
 *     destroyed mid-keystroke by exactly that mistake.
 *
 *   * THE FIELD THE USER JUST EDITED IS NEVER WRITTEN BACK. See `changed`
 *     below. We do not argue with the keystroke that woke us.
 *
 *   * THE FIELDS WRITTEN ARE NOT THE FIELDS TYPED INTO. The five written
 *     columns are Metal, Composition, PM %, PM Weight and Weight; the key
 *     fields are Year, Denomination, Country, Coin Type — plus Metal and
 *     Composition, which is precisely why the previous point exists.
 *
 *   * THIS DOES NOT REPLACE the Settings > Maintenance backfill, which still
 *     covers the coins already in the database. The two MUST NOT disagree
 *     about what a coin is made of, and they cannot, because both ask
 *     `inferPmFields` in pm-fill.ts and neither owns a rule of its own. There
 *     is no second inference in this file. They differ only in what they may
 *     WRITE: the backfill fills blanks and stops; this one may also, with the
 *     user's explicit consent, correct a value the user's own edit has just
 *     made wrong.
 *
 * ---- WHAT COUNTS AS "ENOUGH INFORMATION" ----
 * There is no threshold in this file, and inventing one would be a bug. The
 * question "is there enough to go on?" is already answered, correctly and in
 * one place, by the inference refusing to commit: `composePmFields` returns
 * `null` whenever the reference table has no unambiguous row AND the coarse
 * metal fallback cannot place the coin either. A 1942 nickel (two alloys
 * struck), a bare year with no denomination, a half-typed country — all
 * answer nothing, and "nothing" arrives here as an empty plan.
 *
 * "Year and denomination" describes the common case and makes a bad
 * specification: a "Gold Eagle" names its metal with no year at all, and a
 * 1982 cent names nothing with both.
 *
 * ---- THE GOVERNING RULE OF THIS WHOLE AREA STILL APPLIES ----
 *     A WRONG PURITY SILENTLY PRODUCES A WRONG MELT VALUE.
 *     A BLANK FIELD IS VISIBLE AND THE USER CAN FIX IT.
 *
 * (pm-reference.ts, top of file.) Nothing below adds a guess the reference
 * data would not make, and nothing below overwrites a recorded value without
 * being told to.
  */

import { CoinRecord } from '../types/coin.model';
import {
  PM_FIELD_KEYS,
  PmFieldKey,
  hasAllPmFields,
  inferPmFields,
  isPmFieldBlank
} from './pm-fill';

/**
 * The coin fields whose change re-runs the inference.
 *
 * NOT a judgement call. This is the exact set of columns `inferPmFields`
 * and country go to the reference table; metalContent is the tie-breaking
 * hint; coinType and composition are the coarse fallback's evidence. A field
 * the inference does not read cannot change its answer, so re-running on it
 * would be noise; a field the inference DOES read and that is missing from
 * this list is a field whose edit leaves a stale value on screen, which is
 * objection 1 all over again.
 *
 * A test asserts this list against that function's inputs, so adding a column
 * to the inference without adding it here fails rather than quietly stops
 * working.
 *
 * Note that `metalContent` and `composition` are on BOTH this list and
 * PM_FIELD_KEYS — they are inputs to the inference and outputs of it. That
 * overlap is the reason for the `changed` rule below.
 */
export const AUTOFILL_KEY_FIELDS = [
  'denomination',
  'year',
  'country',
  'coinType',
  'metalContent',
  'composition'
] as const satisfies readonly (keyof CoinRecord)[];

/** One of the fields whose edit re-runs the inference. */
export type AutofillKeyField = (typeof AUTOFILL_KEY_FIELDS)[number];

/** Narrowing helper, so the component can hand us a plain string safely. */
export function isAutofillKeyField(field: string): field is AutofillKeyField {
  return (AUTOFILL_KEY_FIELDS as readonly string[]).includes(field);
}

/**
 * One field where the inference and the record disagree, in the terms the
 * user has to decide it in: which box, what it says now, what it would say.
 */
export interface PmAutofillConflict {
  /** The `CoinRecord` column. */
  field: PmFieldKey;
  /** The label that box carries on screen, e.g. 'PM Weight (g)'. */
  label: string;
  /** What the coin says now. Never blank — a blank is a fill, not a conflict. */
  current: string | number;
  /** What the reference data says. */
  proposed: string | number;
}

/** What an autofill would do, worked out before any of it is done. */
export interface PmAutofillPlan {
  /**
   * Fields that are currently BLANK and can be filled with no question asked.
   * Filling a blank destroys nothing, which is why it needs no consent — the
   * same reasoning the Settings backfill has always run on.
   */
  fills: Partial<CoinRecord>;
  /** Fields that hold something else. The user decides these, all at once. */
  conflicts: PmAutofillConflict[];
  /** `conflicts.length > 0`. Named so the caller reads as a sentence. */
  needsConfirmation: boolean;
  /** Is there anything to do at all? False means: say nothing, write nothing. */
  hasWork: boolean;
}

/** The on-screen label of each writable field. Must match coin-editor-form.html. */
const FIELD_LABELS: Record<PmFieldKey, string> = {
  metalContent: 'Metal',
  composition: 'Composition',
  pmPercent: 'PM %',
  pmWeightGrams: 'PM Weight (g)',
  weight: 'Weight (g)'
};

/**
 * How far two numbers may differ and still count as the same figure.
 *
 * ---- WHY THIS IS NOT `===` ----
 * The single most damaging way to get this feature wrong is to prompt when
 * nothing would actually change. A dialog that appears on every coin and
 * reports no real difference turns entering a batch of coins into a clicking
 * exercise and trains the user to dismiss it unread — at which point the one
 * prompt that mattered goes the same way.
 *
 * Exact equality invites precisely that. `Weight` is DECIMAL(12,5) and
 * `PmPercent` is DECIMAL(5,2), so a value that has been to the database and
 * back is a ROUNDED version of what the reference table holds, and the two
 * would compare unequal forever.
 *
 * 0.005 is half of the coarsest stored step (PM %'s two decimals), so any
 * difference this ignores is one that cannot be represented in the column it
 * came out of — i.e. one the user could not see even if we showed it. A real
 * disagreement between two planchets is orders of magnitude larger: the
 * $1-to-$20 case this feature exists for differs by 6.7 grams.
 */
const NUMERIC_TOLERANCE = 0.005;

/**
 * The "nothing to do" answer.
 *
 * A FUNCTION returning fresh objects rather than one shared frozen constant:
 * a caller that pushed onto a shared `conflicts` array would corrupt every
 * later plan in the session, and an empty plan is returned often enough that
 * the bug would be both easy to write and very hard to find.
 */
function noWork(): PmAutofillPlan {
  return { fills: {}, conflicts: [], needsConfirmation: false, hasWork: false };
}

/**
 * Do the record and the inference actually say the same thing?
 *
 * Text is compared case-insensitively and with the edges trimmed, because
 * "silver" and "Silver " are the same statement about a coin and a prompt
 * that said otherwise would be the noise described above. Numbers are
 * compared with `NUMERIC_TOLERANCE`.
 */
function pmValuesAgree(current: unknown, proposed: unknown): boolean {
  if (typeof current === 'number' && typeof proposed === 'number') {
    return Math.abs(current - proposed) < NUMERIC_TOLERANCE;
  }
  if (typeof current === 'string' && typeof proposed === 'string') {
    return current.trim().toLowerCase() === proposed.trim().toLowerCase();
  }
  return current === proposed;
}

export interface PlanPmAutofillOptions {
  /**
   * The key field(s) the user has just committed an edit to, if any.
   *
   * Two things follow from a non-empty list, and they are the whole reason it
   * exists:
   *
   *   1. THE INFERENCE RUNS EVEN ON A COMPLETE COIN. With no key change, a
   *      coin that already has all five fields is left entirely alone — there
   *      is nothing to learn and no reason to spend a lookup, let alone to
   *      second-guess a finished record. But once the user changes the
   *      denomination from "$1" to "$20", the five values that are there are
   *      no longer a finished record; they are a description of a different
   *      coin. That is the case that must re-run.
   *
   *   2. THE CHANGED FIELD ITSELF IS NEVER WRITTEN. Metal and Composition are
   *      both inputs to the inference and outputs of it. A user who has just
   *      typed a Composition in their own words has made a statement; coming
   *      straight back with "shall I replace that with the catalogue wording?"
   *      is the software arguing with the keystroke that woke it. The rest of
   *      the coin may still be filled from it — that is the point of reading
   *      it as evidence — but the field itself is left exactly as typed.
   */
  changed?: readonly AutofillKeyField[];
}

/**
 * Work out what the editor's autofill would do to this coin, WITHOUT doing
 * any of it.
 *
 * Pure, and deliberately so: it takes a plain coin object and returns a plain
 * description. No signals, no DOM, no confirm dialog, no HTTP. That is what
 * lets the behaviour above be tested exhaustively under Node with no jsdom,
 * and it is what keeps the component down to "ask, then write what it says".
 *
 * @param coin The coin AS IT NOW STANDS, with the user's just-committed edit
 *   already applied. The caller is responsible for that: an Angular `input()`
 *   signal does not refresh within the same synchronous handler that wrote to
 *   it, so a component reading `coin()` immediately after calling
 *   `updateCoin` would be planning against the value the user just replaced.
 */
export function planPmAutofill(
  coin: Partial<CoinRecord>,
  options?: PlanPmAutofillOptions
): PmAutofillPlan {
  const changed = options?.changed ?? [];

  // Nothing was re-described and there is nothing missing. Do not even ask
  // the question: a finished record that nobody has touched is not ours to
  // reconsider. (This is also the cheap path, taken on most edits.)
  if (changed.length === 0 && hasAllPmFields(coin)) return noWork();

  /*
   * TWO ATTEMPTS, AND THE ORDER MATTERS.
   *
   * The first asks WITHOUT the coin's recorded metal. After the user changes
   * "$1" to "$20" the record still says "Silver", because that is what the
   * previous inference wrote — and fed back in as a hint it matches no $20
   * row, so the table declines and the stale 26.73 g survives. A stale output
   * must not be allowed to veto its own replacement.
   *
   * The second asks WITH it, and only when the first answered nothing. That
   * is the 1849-1889 "$1" case: gold dollar or silver dollar, nothing else in
   * the record distinguishes them, and the recorded metal is the only
   * evidence there is. Reaching it second means it breaks ties and never
   * overrides a definite answer.
   */
  const inferred =
    inferPmFields(coin, { useRecordedMetalAsHint: false }) ?? inferPmFields(coin);

  // Neither the reference table nor the coarse fallback would commit. There
  // is no third guess here and there must never be one: a visible blank beats
  // a silently wrong number.
  if (!inferred) return noWork();

  const fills: Partial<CoinRecord> = {};
  const conflicts: PmAutofillConflict[] = [];

  for (const key of PM_FIELD_KEYS) {
    const proposed = inferred[key];

    // The inference has nothing to say about this one (a bronze cent has no
    // PM weight; the coarse fallback knows only the metal). Never invented.
    if (proposed === undefined) continue;

    // Never argue with the field the user has just this moment edited.
    if ((changed as readonly string[]).includes(key)) continue;

    const current = coin[key];

    if (isPmFieldBlank(current)) {
      (fills as Record<string, unknown>)[key] = proposed;
      continue;
    }

    if (pmValuesAgree(current, proposed)) continue;

    conflicts.push({
      field: key,
      label: FIELD_LABELS[key],
      current: current as string | number,
      proposed
    });
  }

  const hasWork = Object.keys(fills).length > 0 || conflicts.length > 0;
  if (!hasWork) return noWork();

  return { fills, conflicts, needsConfirmation: conflicts.length > 0, hasWork: true };
}

/**
 * Turn a plan plus the user's answer into the fields to write.
 *
 * ---- WHY A DECLINED PROMPT WRITES NOTHING AT ALL ----
 * Not even the blanks, which did not conflict and which the user was never
 * asked about. That looks over-cautious until you look at where the values
 * come from: all five are read off ONE row of the reference table. If the
 * user says "no, this coin does not weigh 33.4 grams", what they are
 * rejecting is that row — and writing the other four fields from it anyway
 * produces a record that is internally inconsistent in a way nothing on
 * screen explains: Metal "Gold" and PM Weight 30.09 g sitting next to the
 * silver-dollar weight the user insisted on keeping. A melt value computed
 * from that is confidently wrong, which is the one outcome this whole area of
 * the app is built to avoid.
 *
 * "No" therefore means no, and the coin is left exactly as the user typed it.
 * The blanks are not lost: the next key-field edit offers them again, and the
 * Settings backfill will still fill them.
 *
 * When there is no conflict at all, `accepted` is irrelevant — there was no
 * question — and the blanks are written. That is the silent path, and it is
 * the one that runs on almost every coin.
 */
export function pmAutofillWrites(
  plan: PmAutofillPlan,
  accepted: boolean
): Partial<CoinRecord> {
  if (plan.conflicts.length === 0) return { ...plan.fills };
  if (!accepted) return {};

  const writes: Partial<CoinRecord> = { ...plan.fills };
  for (const conflict of plan.conflicts) {
    (writes as Record<string, unknown>)[conflict.field] = conflict.proposed;
  }
  return writes;
}

/**
 * The question, as one piece of text.
 *
 * ONE PROMPT, NOT ONE PER FIELD. A coin whose denomination changed from "$1"
 * to "$20" disagrees about four fields at once, and four dialogs in a row for
 * a single edit is not a choice, it is a punishment. The user is being asked
 * one thing — "is this the coin I think it is?" — so they are asked it once,
 * with the evidence laid out.
 *
 * Every line shows BOTH values. A prompt that named the field and the new
 * value only would be asking the user to remember what they had typed, which
 * is the one thing they are least able to do at the moment the dialog
 * appears.
 */
export function describePmAutofillConflicts(
  conflicts: readonly PmAutofillConflict[]
): string {
  if (conflicts.length === 0) return '';

  const lines = conflicts.map(
    (c) => `  ${c.label}: ${formatValue(c.current)}  ->  ${formatValue(c.proposed)}`
  );

  return [
    'This coin’s details now point to different metal and weight figures.',
    '',
    'Replace the values below?',
    '',
    ...lines,
    '',
    'Choose Cancel to keep everything exactly as it is.'
  ].join('\n');
}

/**
 * A value as the dialog should show it.
 *
 * An empty string is rendered as "(blank)" rather than as nothing: a line
 * reading "Composition:  ->  90% Silver, 10% Copper" looks like a rendering
 * bug, and a user who thinks the dialog is broken does not read the rest of
 * it. (A blank current value only reaches here via a caller that built a
 * conflict by hand — `planPmAutofill` classes a blank as a silent fill — but
 * the formatter is public and should not produce nonsense either way.)
 */
function formatValue(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return value.trim() === '' ? '(blank)' : value;
}
