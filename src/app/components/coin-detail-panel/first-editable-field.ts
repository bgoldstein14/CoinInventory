/*
 * "Add Coin" puts the caret somewhere useful.
 *
 * Pressing Add Coin creates a blank row and opens the detail panel on it. An
 * open panel the user still has to click into is only half of the gesture —
 * the point of opening it was that there was nowhere visible to type. So the
 * panel focuses its first field.
 *
 * "First field" is a decision, and decisions in this project live in pure
 * modules: the suite runs under Node with no jsdom, so anything written
 * inline in a component is untestable. The component does the querying and
 * the `.focus()`; this file decides WHICH of the elements it found.
 *
 * The three skips below are the ones that actually occur in the coin editor:
 *
 *   - DISABLED fields. `.focus()` on one silently does nothing, so taking it
 *     as the answer means the caret lands nowhere at all.
 *   - type="hidden". An <input> that is not on the screen.
 *   - Fields explicitly removed from the tab order (`tabindex="-1"`). If the
 *     editor has deliberately taken a control out of the keyboard's reach,
 *     dropping the caret into it anyway is worse than doing nothing.
 */

/** The parts of a form control this module reads. A plain object satisfies it. */
export interface FocusableFieldLike {
  readonly tagName?: string | null;
  readonly type?: string | null;
  readonly disabled?: boolean;
  /**
   * `string` as well as `boolean` because the DOM's own `hidden` is
   * `boolean | "until-found"`, and an element hidden until found is still
   * not somewhere to put the caret. Both spellings are simply truthy.
   */
  readonly hidden?: boolean | string;
  readonly tabIndex?: number;
}

const EDITABLE_TAG_NAMES = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

/** Could the caret usefully be put in this control? */
export function isEditableField(field: FocusableFieldLike | null | undefined): boolean {
  if (!field) return false;
  const tagName = typeof field.tagName === 'string' ? field.tagName.toUpperCase() : '';
  if (!EDITABLE_TAG_NAMES.has(tagName)) return false;
  if (field.disabled) return false;
  if (field.hidden) return false;
  if (typeof field.type === 'string' && field.type.toLowerCase() === 'hidden') return false;
  if (typeof field.tabIndex === 'number' && field.tabIndex < 0) return false;
  return true;
}

/**
 * The first control worth focusing, or null when the panel holds none.
 *
 * Null is a perfectly ordinary answer — it is what a panel renders before
 * its form has been laid out — and the caller must treat it as "leave focus
 * where it is", never as a reason to focus something else.
 */
export function firstEditableField<T extends FocusableFieldLike>(
  fields: readonly T[]
): T | null {
  for (const field of fields) {
    if (isEditableField(field)) return field;
  }
  return null;
}
