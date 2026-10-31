/* ===========================================================================
 * custom-option-mode.ts — "the user picked Other" as a piece of state.
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO FIX
 * ---------------------------------------------------------------------------
 * Denomination and Mint mark are <select>s with a trailing "Other" option, and
 * choosing it is supposed to reveal a free-text box. That was implemented by
 * storing a sentinel string in the coin field itself:
 *
 *     <select [ngModel]="coin().denomination" ...>
 *       <option value="__OTHER__">Other</option>
 *     </select>
 *
 *     @if (coin().denomination === '__OTHER__') {
 *       <input (ngModelChange)="updateSelectedCoin('denomination', $event)" />
 *     }
 *
 * Both halves are broken by the same mistake — the *value* is being used to
 * remember a *UI choice*:
 *
 *   TYPING: the first character you type into the box replaces the
 *   denomination with that character. '__OTHER__' is gone, so the `@if` is now
 *   false and the box you are typing into is destroyed mid-keystroke. Exactly
 *   the owner's report: "only one letter/number can be typed and then the box
 *   goes away".
 *
 *   RELOADING: a saved custom denomination such as "Trade Dollar" is a real
 *   value, not the sentinel, so the `@if` is false and the box never reopens.
 *   The coin comes back looking like it has no denomination selected at all.
 *
 *   SAVING: if the user picked Other and then clicked away without typing,
 *   the literal string "__OTHER__" was written to the database as the coin's
 *   denomination.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES INSTEAD
 * ---------------------------------------------------------------------------
 * "This field is in custom mode" becomes its own boolean signal, held here,
 * completely independent of the field's value. The sentinel survives only as
 * the <option>'s value attribute — a token the <select> needs in order to have
 * something to report when "Other" is clicked — and is translated away the
 * instant it reaches the component. It is NEVER stored on a coin.
 *
 * The free-text box is then bound straight to the coin field, like every other
 * text input in the form, and its visibility is driven by this signal. Typing
 * cannot close it, because typing does not touch this signal.
 *
 * ---------------------------------------------------------------------------
 * THE SUBTLE PART: WHEN MAY CUSTOM MODE BE RE-DERIVED?
 * ---------------------------------------------------------------------------
 * On load we want to infer custom mode from the value ("this denomination is
 * not one of the options, so it must be a custom one"). The temptation is to
 * make that a `computed()` or an unguarded `effect()` over the coin signal.
 * DO NOT. The coin signal changes identity on every single field edit, so such
 * a derivation would re-run while the user is typing, and the moment they typed
 * something that happens to match a real option — "$1", say — custom mode would
 * flip to false and the box would vanish under their hands. That is the
 * original bug wearing a different hat.
 *
 * So the re-derivation is guarded by the coin id: it happens once per coin,
 * when a DIFFERENT coin is loaded, and never again while that coin is being
 * edited. `syncForCoin` is where that guard lives.
 * =========================================================================== */

import { signal } from '@angular/core';

/**
 * The <option> value that means "none of the above".
 *
 * Exported so the template, the component and the tests all agree on one
 * spelling. It is a UI token only — see `stripCustomSentinel`.
 */
export const CUSTOM_OPTION_SENTINEL = '__OTHER__';

/**
 * Is `value` something the user typed themselves rather than picked from the
 * list? Blank is not custom (it is simply "not set"), and the sentinel is not
 * custom either (it is not a value at all).
 */
export function isCustomOptionValue(value: string | null | undefined, optionLabels: readonly string[]): boolean {
  const text = (value ?? '').trim();
  if (text.length === 0) return false;
  if (text === CUSTOM_OPTION_SENTINEL) return false;
  return !optionLabels.includes(text);
}

/** The mirror of {@link isCustomOptionValue}: a value that IS in the list. */
export function isKnownOptionValue(value: string | null | undefined, optionLabels: readonly string[]): boolean {
  const text = (value ?? '').trim();
  if (text.length === 0) return false;
  return optionLabels.includes(text);
}

/**
 * Last line of defence before anything is persisted.
 *
 * The code paths below are written so the sentinel can never reach a coin, but
 * this is cheap and it means that even a future careless
 * `updateSelectedCoin('denomination', someSelectValue)` cannot put "__OTHER__"
 * into the database.
 */
export function stripCustomSentinel(value: string | null | undefined): string {
  const text = value ?? '';
  return text === CUSTOM_OPTION_SENTINEL ? '' : text;
}

/**
 * Per-field "is the custom text box open?" state.
 *
 * One instance per field (one for Denomination, one for Mint mark) rather than
 * two bespoke pairs of signals, so the two fields cannot drift apart — the
 * owner reported the bug for Denomination but it was identical for Mint mark.
 *
 * Deliberately a plain class with no Angular injection: it can be constructed
 * with `new` in a unit test, which matters because the template itself is not
 * testable in this project (the suite runs under Node with no jsdom).
 */
export class CustomOptionMode {
  private readonly customMode = signal(false);

  /**
   * Which coin we last derived custom mode for. Plain field, not a signal:
   * it is bookkeeping for the guard, and nothing should react to it.
   */
  private lastSyncedCoinId: string | null = null;

  /** True while the free-text box should be shown. */
  readonly isCustom = this.customMode.asReadonly();

  /**
   * Re-derive custom mode because a coin was loaded into the editor.
   *
   * Two guards, both load-bearing:
   *
   *   - an EMPTY option list means the lookup tables have not come back from
   *     the server yet. Deriving now would decide that every non-blank
   *     denomination is "custom", because nothing is in the list to match. We
   *     return without recording a sync, so the next call (once the lookups
   *     arrive) still does the work.
   *
   *   - the SAME coin id means this is a re-render caused by the user editing
   *     a field, not a new coin being opened. Re-deriving here is what would
   *     yank the box away mid-typing. See the header comment.
   */
  syncForCoin(coinId: string, value: string, optionLabels: readonly string[]): void {
    if (optionLabels.length === 0) return;
    if (coinId === this.lastSyncedCoinId) return;

    this.lastSyncedCoinId = coinId;
    this.customMode.set(isCustomOptionValue(value, optionLabels));
  }

  /** The user chose "Other" in the select. */
  enterCustomMode(): void {
    this.customMode.set(true);
  }

  /** The user chose a real option in the select. */
  leaveCustomMode(): void {
    this.customMode.set(false);
  }

  /**
   * What the <select> should currently show as selected.
   *
   * In custom mode this is the sentinel, so the closed select reads "Other"
   * even though the coin's stored value is the user's own text. That is the
   * point: the select and the text box are two views of one field, and the
   * select has no option matching "Trade Dollar" to highlight.
   */
  selectValue(fieldValue: string): string {
    return this.customMode() ? CUSTOM_OPTION_SENTINEL : fieldValue;
  }
}
