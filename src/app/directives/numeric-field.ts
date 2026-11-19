/*
 * Numeric input for the coin editor (weight, PM weight, PM %, price, value).
 *
 * Shows a formatted value ("$1,250.00") when not focused and leaves the user's
 * raw text alone while typing. Rule: while the input has focus, nothing writes
 * to `element.value` — reformatting mid-edit moves the caret to the end.
 * ngModel is not used for the same reason; the element is driven directly.
 */

import { Directive, ElementRef, effect, inject, input, output } from '@angular/core';
import { formatNumericValue, parseNumericInput } from './numeric-field-format';

@Directive({
  selector: 'input[appNumericField]',
  host: {
    // type="number" can't hold "$" or separators and blanks itself on invalid text.
    type: 'text',
    inputmode: 'decimal',
    '(focus)': 'onFocus()',
    '(input)': 'onInput()',
    '(blur)': 'onBlur()'
  }
})
export class NumericField {
  private readonly element = inject<ElementRef<HTMLInputElement>>(ElementRef);

  /** The stored value, e.g. `[appNumericField]="coin().weight"`. */
  readonly value = input.required<number | null | undefined>({ alias: 'appNumericField' });

  /** Digits after the decimal point in the canonical display. */
  readonly decimals = input(2);

  /** Literal prefix for the canonical display, e.g. "$". */
  readonly prefix = input('');

  /** Thousands separators in the canonical display. */
  readonly group = input(false);

  /**
   * Parsed number on every keystroke, or `null` when the box is empty.
   * Blur never emits: each emit is a one-field save, and a blur emit would save
   * a field the user didn't change.
   */
  readonly numericValueChange = output<number | null>();

  /** Plain field, not a signal: it is only a guard and must not trigger effects. */
  private focused = false;

  constructor() {
    effect(() => {
      // Read every signal before the focus guard so the effect stays subscribed
      // to all of them (it only tracks what it read on its last run).
      const value = this.value();
      const decimals = this.decimals();
      const prefix = this.prefix();
      const group = this.group();

      if (this.focused) return;

      this.element.nativeElement.value = formatNumericValue(value, { decimals, prefix, group });
    });
  }

  protected onFocus(): void {
    this.focused = true;
  }

  protected onInput(): void {
    // No reformatting here: "1." and "-" are valid half-typed states. Emitting on
    // every keystroke means nothing is lost if the panel closes without a blur.
    this.numericValueChange.emit(parseNumericInput(this.element.nativeElement.value));
  }

  protected onBlur(): void {
    this.focused = false;
    this.renderCanonicalText();
  }

  /**
   * Repaint from the stored value (not the box's text), so the user sees what
   * was actually saved. A briefly stale value is corrected by the effect.
   */
  private renderCanonicalText(): void {
    this.element.nativeElement.value = formatNumericValue(this.value(), {
      decimals: this.decimals(),
      prefix: this.prefix(),
      group: this.group()
    });
  }
}
