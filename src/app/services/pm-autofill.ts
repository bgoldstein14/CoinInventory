 /*
  * Fills metal and weight fields while a coin is added or edited by hand. Blanks
  * are filled silently; after a key-field change the inference re-runs and the
  * user is asked before any differing value is overwritten.
  *
  * - Triggered by a committed edit (the control's native `change` event, on blur
  *   or Enter), not keystrokes or a timer. There is deliberately no `effect()`
  *   over the coin signal: it re-runs on every keystroke (see
  *   components/coin-editor-form/custom-option-mode.ts).
  * - The field the user just edited is never written back.
  * - Uses `inferPmFields` (pm-fill.ts), the same inference as the Settings
  *   backfill, so they can't disagree. The difference: this may also correct a
  *   value, with the user's consent.
  *
  * There is no "enough information" threshold: `composePmFields` returns null
  * whenever it can't place the coin (1942 nickel, a year with no denomination),
  * which arrives here as an empty plan.
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
 * Coin fields whose change re-runs the inference: exactly the inputs of
 * `inferPmFields` (a test checks this). `metalContent` and `composition` are
 * both inputs and outputs (also in PM_FIELD_KEYS), hence the `changed` rule.
 */
export const AUTOFILL_KEY_FIELDS = [
  'denomination',
  'year',
  'country',
  'coinType',
  'metalContent',
  'composition'
] as const satisfies readonly (keyof CoinRecord)[];

/** A field whose edit re-runs the inference. */
export type AutofillKeyField = (typeof AUTOFILL_KEY_FIELDS)[number];

/** Narrows a plain string from the component. */
export function isAutofillKeyField(field: string): field is AutofillKeyField {
  return (AUTOFILL_KEY_FIELDS as readonly string[]).includes(field);
}

/** One field where inference and record disagree: which box, its value now, the proposed value. */
export interface PmAutofillConflict {
  /** The `CoinRecord` column. */
  field: PmFieldKey;
  /** The box's on-screen label, e.g. 'PM Weight (g)'. */
  label: string;
  /** The current value; never blank (a blank is a fill, not a conflict). */
  current: string | number;
  /** What the reference data says. */
  proposed: string | number;
}

/** What an autofill would do, worked out before doing any of it. */
export interface PmAutofillPlan {
  /** Currently blank fields, filled without asking (filling a blank destroys nothing). */
  fills: Partial<CoinRecord>;
  /** Fields holding a different value; the user decides these together. */
  conflicts: PmAutofillConflict[];
  /** `conflicts.length > 0`. Named so the caller reads as a sentence. */
  needsConfirmation: boolean;
  /** Whether there is anything to do at all. */
  hasWork: boolean;
}

/** On-screen label of each writable field; must match coin-editor-form.html. */
const FIELD_LABELS: Record<PmFieldKey, string> = {
  metalContent: 'Metal',
  composition: 'Composition',
  pmPercent: 'PM %',
  pmWeightGrams: 'PM Weight (g)',
  weight: 'Weight (g)'
};

/**
 * How far two numbers may differ and still count as equal. Not `===`: values
 * round-tripped through the database (Weight DECIMAL(12,5), PmPercent
 * DECIMAL(5,2)) are rounded, and prompting when nothing really changes trains
 * the user to dismiss the dialog. 0.005 is half PM %'s smallest step; real
 * conflicts (e.g. $1 to $20) differ by grams.
 */
const NUMERIC_TOLERANCE = 0.005;

/** A fresh empty plan each time, so callers can't corrupt a shared `conflicts` array. */
function noWork(): PmAutofillPlan {
  return { fills: {}, conflicts: [], needsConfirmation: false, hasWork: false };
}

/**
 * Whether record and inference say the same thing: text compared trimmed and
 * case-insensitive, numbers within `NUMERIC_TOLERANCE`.
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
   * The key field(s) the user just committed an edit to. When non-empty:
   *   1. The inference runs even on a complete coin: after "$1" becomes "$20",
   *      the existing values describe a different coin.
   *   2. The changed field itself is never written, even though it is also an
   *      output (Metal, Composition). The rest of the coin may still be filled.
   */
  changed?: readonly AutofillKeyField[];
}

/**
 * Works out what the editor's autofill would do, without doing it. Pure (no
 * signals, DOM, dialogs or HTTP), so it is testable under Node.
 *
 * @param coin the coin with the just-committed edit already applied. The caller
 *   must supply it: an `input()` signal doesn't refresh within the same
 *   synchronous handler that called `updateCoin`.
 */
export function planPmAutofill(
  coin: Partial<CoinRecord>,
  options?: PlanPmAutofillOptions
): PmAutofillPlan {
  const changed = options?.changed ?? [];

  // Nothing re-described and nothing missing: leave a finished record alone.
  if (changed.length === 0 && hasAllPmFields(coin)) return noWork();

  /*
   * Two attempts, in order. First without the recorded metal: after "$1" becomes
   * "$20" the record still says "Silver" from the previous inference, which as a
   * hint would match no $20 row and keep the stale weight. Then, only if that
   * found nothing, with it: the recorded metal is the only evidence for the
   * 1849-1889 "$1" (gold or silver dollar), so it breaks ties but never overrides.
   */
  const inferred =
    inferPmFields(coin, { useRecordedMetalAsHint: false }) ?? inferPmFields(coin);

  // Neither source would commit; no further guess.
  if (!inferred) return noWork();

  const fills: Partial<CoinRecord> = {};
  const conflicts: PmAutofillConflict[] = [];

  for (const key of PM_FIELD_KEYS) {
    const proposed = inferred[key];

    // Nothing to say about this field; never invented.
    if (proposed === undefined) continue;

    // Never overwrite the field the user just edited.
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
 * The fields to write, from a plan and the user's answer.
 *
 * A declined prompt writes nothing, not even the blanks: all five values come
 * from one reference row, and the user has rejected that row. Writing the rest
 * would leave an inconsistent record (e.g. Gold and 30.09 g next to a silver
 * dollar's weight). The blanks are offered again on the next key-field edit and
 * by the Settings backfill. With no conflict, `accepted` is irrelevant and the
 * blanks are written.
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
 * The confirmation question as one piece of text: one prompt for all conflicts
 * (a "$1" -> "$20" change differs in four fields), each line showing current and
 * proposed values.
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

/** A value for the dialog; '' is shown as "(blank)" so the line doesn't look broken. */
function formatValue(value: string | number): string {
  if (typeof value === 'number') return String(value);
  return value.trim() === '' ? '(blank)' : value;
}
