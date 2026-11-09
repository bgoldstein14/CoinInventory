 /*
 * denomination-display.ts — how a coin's denomination is written on screen
 *
 * THE SITUATION THIS EXISTS FOR
 *
 * As of migration 011 a coin carries TWO denomination fields, and the design
 * (§4.1) is explicit that it carries both on purpose:
 *
 *     Coins.DenominationId   the canonical link, when one could be
 *                            established. NULL is normal, not an error.
 *     Coins.Denomination     what the SOURCE said — typed by the user, or
 *                            read out of a QIF, a CSV or a spreadsheet. Never
 *                            rewritten by anything (migration 014 reads it
 *                            and does not touch it).
 *
 * They diverge in exactly two situations, both intended and both visible:
 * an import whose text resolved to nothing, and a denomination the user
 * deleted (§4.4 nulls the id and leaves the text alone).
 *
 * WHY THE "Other (...)" FORM AND NOT A BARE "Other"
 *
 * Deleting a denomination leaves its coins reading "Other". A bare "Other"
 * says something has been lost without saying WHAT, on a row the user can then
 * do nothing with. `Other (8 Reales)` names the thing, so it can be seen,
 * recognised and re-mapped. That costs one column and no behaviour.
 *
 * DO NOT remove the literal `Other (8 Reales)` from this header. A test in
 * denomination-display.spec.ts strips the comments from THIS FILE and asserts
 * the phrase is gone, which is how it proves its comment-stripper works before
 * relying on it to scan all of src/ for rogue label-builders. Delete the
 * phrase here and that guard still passes while proving nothing.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES INLINE
 *
 * The rule is short enough that the next grid cell, report row or tooltip
 * will re-derive it rather than import it. The moment there are two copies
 * they are a FORK, not a duplicate: one says `Other (8 Reales)`, the other
 * `Other - 8 Reales`, and the same coin reads two ways on two screens with
 * nothing failing. denomination-display.spec.ts greps the whole of src/ and
 * fails if any other file builds this string.
 *
 * Pure, dependency-free and DOM-free, so it is callable from the grid, the
 * reports, the CSV export and the Node tests alike.
  */

/**
 * The literal that opens an unresolved denomination.
 *
 * Exported so that callers which need to RECOGNISE the form (a filter that
 * must not bucket `Other (8 Reales)` with `Other (100 Soles)`, say) can do it
 * without retyping the string and drifting from it.
 */
export const OTHER_DENOMINATION_PREFIX = 'Other (';

/**
 * What a coin with no denomination at all shows.
 *
 * An em dash, matching every other "nothing recorded" cell in the app
 * (types/inventory-columns.ts, report-fields.ts).
 */
export const NO_DENOMINATION = '—';

/**
 * Stored values that are NOT a denomination, however much they look like text.
 *
 * WHY THIS LIST EXISTS — residue from a fixed bug, found in real data
 *
 * `__OTHER__` is the <option> value the editor's "Other" choice carries. It is
 * a UI token and was never meant to reach the database — see
 * components/coin-editor-form/custom-option-mode.ts, whose header documents
 * the defect that put it there (picking Other and clicking away without
 * typing wrote the literal string as the coin's denomination).
 *
 * That defect is fixed and `stripCustomSentinel` keeps it fixed on the way IN,
 * but rows written before the fix still hold the sentinel.
 *
 * Without this list such a coin renders `Other (__OTHER__)` — which tells the
 * user nothing, cannot be looked up, and reads like a bug in the app rather
 * than a blank field in their data. Treating it as absent makes the row say
 * `—`, which is the truth: no denomination is recorded, go and pick one.
 *
 * It is matched case-sensitively and after trimming, because it was written by
 * code and is always exactly this. A user who genuinely types `__OTHER__` as a
 * denomination gets a blank cell; that is an acceptable trade for a string no
 * coin has ever been called.
 *
 * The constant is NOT imported from custom-option-mode.ts on purpose: that is
 * a component-folder module, and this is a dependency-free service the
 * reports, the CSV export and the Node specs all call. A spec asserts the two
 * spellings agree, so they cannot drift.
 */
const NON_DENOMINATION_TEXT: readonly string[] = ['__OTHER__'];

/**
 * The display rule of design §4.1, in full.
 *
 * @param label the Label of the denomination `Coins.DenominationId` points
 *              at, or null/empty when the id is not set or no longer resolves
 *              to an active row
 * @param recordedText `Coins.Denomination` exactly as stored
 *
 * The label wins whenever there is one, including when it disagrees with the
 * recorded text — which is the NORMAL state after a resolution, because the
 * text keeps saying `Pillar Dollar` while the id says `8 Reales`. The id is
 * the authority; the text is evidence of where the row came from.
 *
 * Both sides are trimmed for display and neither is otherwise rewritten. The
 * trim is not cosmetic: a column that has held free text for years holds
 * '   ' somewhere, and `Other (   )` is a visible defect on a row the owner
 * cannot do anything about. Changing the user's spelling, on the other hand,
 * would destroy the only evidence of what the source said.
 */
export function denominationDisplay(
  label: string | null | undefined,
  recordedText: string | null | undefined
): string {
  const resolved = String(label ?? '').trim();
  if (resolved) return resolved;

  const recorded = String(recordedText ?? '').trim();
  // A sentinel that leaked into the data is not evidence of anything — see
  // NON_DENOMINATION_TEXT. Falls through to the em dash.
  if (recorded && !NON_DENOMINATION_TEXT.includes(recorded)) {
    return `${OTHER_DENOMINATION_PREFIX}${recorded})`;
  }

  return NO_DENOMINATION;
}
