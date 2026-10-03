/* ===========================================================================
 * numeric-field.ts — one directive for every number box in the coin editor.
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 * Every numeric input in the editor used to be wired like this:
 *
 *     [ngModel]="formatMoneyInput(coin().purchasePrice)"
 *     (ngModelChange)="updateSelectedCoin('purchasePrice', parseMoneyInput($event))"
 *
 * Read that round trip carefully, because the failure is not obvious:
 *
 *   1. you type "1"
 *   2. ngModelChange fires, parseMoneyInput("1") -> 1, the coin is updated
 *   3. the coin signal changes, so [ngModel] is re-evaluated
 *   4. formatMoneyInput(1) -> "$1.00", which is NOT the text you typed
 *   5. ngModel writes "$1.00" back into the box, and the browser puts the
 *      caret at the END of the replaced text
 *
 * So after a single keystroke the user is parked after the decimals and can
 * only append digits there. That is exactly what the owner described: "they
 * allow a numeral to be entered but then automatically format and force the
 * user to enter numerals at the end of the decimal places."
 *
 * ---------------------------------------------------------------------------
 * WHY A DIRECTIVE RATHER THAN SIX FIXES
 * ---------------------------------------------------------------------------
 * The bug is not in any one field, it is in the *binding shape*, and that shape
 * was copy-pasted onto Weight, PM Weight, PM %, Price and Value. Fixing them
 * individually would leave the next numeric field someone adds broken again,
 * because the obvious thing to copy would still be the broken pattern.
 *
 * A directive was chosen over a wrapper component for three reasons:
 *   - it keeps the <input> in the template, so the surrounding
 *     `.detail-field` label/grid CSS keeps working untouched;
 *   - it does not introduce an extra element that would have to be taught
 *     about every attribute (maxlength, inputmode, aria-label, disabled...);
 *   - the thing being fixed IS element behaviour (focus, blur, caret), which
 *     is what directives are for.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MUST NOT BE BROKEN
 * ---------------------------------------------------------------------------
 * WHILE THE INPUT HAS FOCUS, NOTHING WRITES TO `element.value`.
 *
 * That single rule is what keeps the caret still. If a future change adds a
 * code path that assigns to `element.value` without checking `this.focused`,
 * the original bug comes straight back. There is deliberately exactly one
 * assignment in this file (`renderCanonicalText`) and exactly two callers of
 * it, both of which only run when the field is not focused.
 *
 * Note also that this directive does NOT use ngModel. ngModel's own
 * model-to-view write is half of the problem above, so the input is driven
 * directly instead.
 * =========================================================================== */

import { Directive, ElementRef, effect, inject, input, output } from '@angular/core';
import { formatNumericValue, parseNumericInput } from './numeric-field-format';

@Directive({
  selector: 'input[appNumericField]',
  host: {
    // Plain text, not type="number": the canonical display carries a "$" and
    // thousands separators, which type="number" refuses to hold, and a number
    // input also silently blanks itself when it considers the text invalid.
    type: 'text',
    // Tells phones/tablets to offer the numeric keypad even though the field
    // is type="text".
    inputmode: 'decimal',
    '(focus)': 'onFocus()',
    '(input)': 'onInput()',
    '(blur)': 'onBlur()'
  }
})
export class NumericField {
  private readonly element = inject<ElementRef<HTMLInputElement>>(ElementRef);

  /**
   * The stored value from the coin record. Named after the selector so the
   * template reads `[appNumericField]="coin().weight"`.
   */
  readonly value = input.required<number | null | undefined>({ alias: 'appNumericField' });

  /** Digits after the decimal point in the canonical display. */
  readonly decimals = input(2);

  /** Literal prefix for the canonical display, e.g. "$". */
  readonly prefix = input('');

  /** Thousands separators in the canonical display. */
  readonly group = input(false);

  /**
   * Fires on every keystroke with the parsed number, or `null` when the box has
   * been emptied.
   *
   * IMPORTANT: this is the ONLY place the directive ever emits. In particular
   * blur does not emit. The coin editor sends a one-field PUT for every emit,
   * and a blur-triggered emit would write a field the user never touched —
   * widening the save payload is a bug this project has been bitten by before.
   */
  readonly numericValueChange = output<number | null>();

  /**
   * True between `focus` and `blur`. A plain field rather than a signal on
   * purpose: nothing should *react* to it, it is only ever a guard, and making
   * it reactive would risk an effect re-running (and so re-rendering the text)
   * at the exact moment we are trying to leave the text alone.
   */
  private focused = false;

  constructor() {
    effect(() => {
      // Read EVERY input signal before the focus guard. An effect only tracks
      // the signals it actually read on its last run, so bailing out early
      // would quietly unsubscribe this effect from `value` and the box would
      // stop updating when a different coin is selected.
      const value = this.value();
      const decimals = this.decimals();
      const prefix = this.prefix();
      const group = this.group();

      // The user is typing. Their text wins — see "THE RULE" above.
      if (this.focused) return;

      this.element.nativeElement.value = formatNumericValue(value, { decimals, prefix, group });
    });
  }

  protected onFocus(): void {
    this.focused = true;
  }

  protected onInput(): void {
    // Read the box, tell the form, and touch nothing. No formatting, no caret
    // repositioning, no "helpful" correction of a half-typed number like "1."
    // or "-" — those are legitimate intermediate states.
    //
    // The model is still kept up to date on every keystroke (rather than only
    // on blur) so that nothing is lost if the user clicks straight onto another
    // coin, or the panel is closed, without the field ever blurring normally.
    this.numericValueChange.emit(parseNumericInput(this.element.nativeElement.value));
  }

  protected onBlur(): void {
    this.focused = false;
    this.renderCanonicalText();
  }

  /**
   * Repaint the box from the stored value in its canonical form.
   *
   * Reads `value()` rather than re-parsing the box's own text, so what the user
   * ends up looking at is genuinely what was saved — if the parse turned
   * "ask dealer" into 0, the box says so instead of keeping the fiction.
   *
   * If the model write from the final keystroke has not landed yet this may
   * briefly paint a stale number; that self-corrects, because the effect above
   * re-runs the moment `value()` changes and the field is no longer focused.
   */
  private renderCanonicalText(): void {
    this.element.nativeElement.value = formatNumericValue(this.value(), {
      decimals: this.decimals(),
      prefix: this.prefix(),
      group: this.group()
    });
  }
}
