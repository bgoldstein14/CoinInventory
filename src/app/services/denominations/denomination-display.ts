 /*
  * How a coin's denomination is shown. This is the only place the display rule
  * is implemented; denomination-display.spec.ts fails if another file builds it.
  *
  * A coin carries two fields (migration 011, design §4.1):
  *     Coins.DenominationId   canonical link when one could be established; NULL is normal
  *     Coins.Denomination     what the source said; never rewritten
  *
  * The label of the linked row is shown when there is one. Otherwise the
  * recorded text is shown as `Other (8 Reales)`, which names what is unresolved
  * so the user can recognise and re-map it. (The spec checks that this literal
  * is removed when comments are stripped from this file, so keep it here.)
  *
  * Pure and dependency-free: used by the grid, reports, CSV export and Node tests.
  */

/**
 * Prefix of an unresolved denomination. Exported so callers that recognise the
 * form don't retype the string.
 */
export const OTHER_DENOMINATION_PREFIX = 'Other (';

/** Shown for a coin with no denomination; the app-wide em dash for "nothing recorded". */
export const NO_DENOMINATION = '—';

/**
 * Stored values that are not a denomination. `__OTHER__` is the editor's
 * "Other" option value, which older rows hold from a since-fixed bug (see
 * components/coin-editor-form/custom-option-mode.ts). Treated as absent so the
 * row shows `—` rather than `Other (__OTHER__)`. Matched exactly, after trimming.
 * Not imported from custom-option-mode.ts to keep this module dependency-free;
 * a spec checks the two spellings agree.
 */
const NON_DENOMINATION_TEXT: readonly string[] = ['__OTHER__'];

/**
 * The display rule (design §4.1).
 *
 * @param label label of the denomination `Coins.DenominationId` points at, or
 *              null/empty when unset or no longer active
 * @param recordedText `Coins.Denomination` as stored
 *
 * The label wins whenever present, even if the recorded text differs (normal
 * after resolution: text `Pillar Dollar`, id `8 Reales`). Both are trimmed for
 * display (so whitespace-only text never shows as `Other (   )`) but otherwise
 * shown as written.
 */
export function denominationDisplay(
  label: string | null | undefined,
  recordedText: string | null | undefined
): string {
  const resolved = String(label ?? '').trim();
  if (resolved) return resolved;

  const recorded = String(recordedText ?? '').trim();
  // A leaked sentinel is treated as no text; falls through to the em dash.
  if (recorded && !NON_DENOMINATION_TEXT.includes(recorded)) {
    return `${OTHER_DENOMINATION_PREFIX}${recorded})`;
  }

  return NO_DENOMINATION;
}
