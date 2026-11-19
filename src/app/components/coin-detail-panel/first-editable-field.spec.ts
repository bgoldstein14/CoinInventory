/* Where the caret goes when Add Coin opens the panel. Elements are plain objects (no jsdom). */
import { describe, expect, it } from 'vitest';
import { firstEditableField, isEditableField } from './first-editable-field';

describe('picking the field to focus', () => {
  it('takes the first editable control it is given', () => {
    const year = { tagName: 'INPUT', type: 'text' };
    const grade = { tagName: 'SELECT' };
    expect(firstEditableField([year, grade])).toBe(year);
  });

  it('accepts a select or a textarea, not only a text box', () => {
    const grade = { tagName: 'SELECT' };
    expect(firstEditableField([grade])).toBe(grade);
    expect(isEditableField({ tagName: 'TEXTAREA' })).toBe(true);
  });

  it('skips a disabled field, where .focus() silently does nothing', () => {
    const disabled = { tagName: 'INPUT', disabled: true };
    const usable = { tagName: 'INPUT' };
    expect(firstEditableField([disabled, usable])).toBe(usable);
  });

  it('skips a hidden input, which is not on the screen', () => {
    const hidden = { tagName: 'INPUT', type: 'hidden' };
    const usable = { tagName: 'INPUT', type: 'text' };
    expect(firstEditableField([hidden, usable])).toBe(usable);
  });

  it('skips an element the DOM reports as hidden until found', () => {
    // `HTMLElement.hidden` is `boolean | "until-found"`, and the string form
    // still means "not visible".
    expect(isEditableField({ tagName: 'INPUT', hidden: 'until-found' })).toBe(false);
    expect(isEditableField({ tagName: 'INPUT', hidden: true })).toBe(false);
  });

  it('skips a field deliberately taken out of the tab order', () => {
    expect(isEditableField({ tagName: 'INPUT', tabIndex: -1 })).toBe(false);
    expect(isEditableField({ tagName: 'INPUT', tabIndex: 0 })).toBe(true);
  });

  it('ignores anything that is not a form control', () => {
    expect(isEditableField({ tagName: 'BUTTON' })).toBe(false);
    expect(isEditableField({ tagName: 'DIV' })).toBe(false);
    expect(isEditableField(null)).toBe(false);
  });

  it('matches a tag name in any case', () => {
    expect(isEditableField({ tagName: 'input' })).toBe(true);
  });

  it('answers null when the panel holds nothing focusable', () => {
    // An ordinary answer: it is what the panel looks like before its form
    // has been laid out. The caller must leave focus where it is.
    expect(firstEditableField([])).toBeNull();
    expect(firstEditableField([{ tagName: 'DIV' }, { tagName: 'BUTTON' }])).toBeNull();
  });
});
