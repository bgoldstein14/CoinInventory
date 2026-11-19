/*
 * Chooses which field to focus when Add Coin opens the detail panel. Skips
 * disabled, hidden and tabindex="-1" controls.
 */

/** The parts of a form control this module reads. A plain object satisfies it. */
export interface FocusableFieldLike {
  readonly tagName?: string | null;
  readonly type?: string | null;
  readonly disabled?: boolean;
  /** Also a string because the DOM's `hidden` can be "until-found". */
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

/** The first focusable control, or null (the caller then leaves focus alone). */
export function firstEditableField<T extends FocusableFieldLike>(
  fields: readonly T[]
): T | null {
  for (const field of fields) {
    if (isEditableField(field)) return field;
  }
  return null;
}
