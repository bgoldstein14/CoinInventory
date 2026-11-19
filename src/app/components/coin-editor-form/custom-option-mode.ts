/*
 * "Other" (custom value) state for the Denomination and Mint mark selects.
 *
 * Whether the free-text box is open is its own signal, not inferred from the field value:
 * otherwise typing would close the box, saved custom values would not reopen it, and the
 * sentinel could be saved. The sentinel exists only as the <option> value.
 *
 * Custom mode is re-derived once per coin (guarded by coin id), never while the coin is being
 * edited, so typing a value that matches a real option does not hide the box.
 */

import { signal } from '@angular/core';

/** The <option> value for "Other". A UI token only; never stored on a coin. */
export const CUSTOM_OPTION_SENTINEL = '__OTHER__';

/** True when the value is the user's own text (not blank, not the sentinel, not in the list). */
export function isCustomOptionValue(value: string | null | undefined, optionLabels: readonly string[]): boolean {
  const text = (value ?? '').trim();
  if (text.length === 0) return false;
  if (text === CUSTOM_OPTION_SENTINEL) return false;
  return !optionLabels.includes(text);
}

/** True when the value is one of the listed options. */
export function isKnownOptionValue(value: string | null | undefined, optionLabels: readonly string[]): boolean {
  const text = (value ?? '').trim();
  if (text.length === 0) return false;
  return optionLabels.includes(text);
}

/** Safety net: never persist the sentinel. */
export function stripCustomSentinel(value: string | null | undefined): string {
  const text = value ?? '';
  return text === CUSTOM_OPTION_SENTINEL ? '' : text;
}

/**
 * Per-field "is the custom text box open?" state. A plain class so it can be unit-tested
 * without TestBed.
 */
export class CustomOptionMode {
  private readonly customMode = signal(false);

  /** Coin id custom mode was last derived for (bookkeeping only). */
  private lastSyncedCoinId: string | null = null;

  /** True while the free-text box should be shown. */
  readonly isCustom = this.customMode.asReadonly();

  /**
   * Re-derive custom mode when a coin is loaded. Skipped while the option list is empty (lookups
   * not loaded yet) and for the coin already synced, so editing never closes the box.
   */
  syncForCoin(coinId: string, value: string, optionLabels: readonly string[]): void {
    if (optionLabels.length === 0) return;
    this.syncWhenReady(coinId, isCustomOptionValue(value, optionLabels));
  }

  /**
   * Same as syncForCoin, but with the caller's own verdict (used for denomination, which is
   * decided by denominationSelectionFor). The caller must wait until lookups are loaded.
   *
   * @param custom the already-decided answer for this coin.
   */
  syncWhenReady(coinId: string, custom: boolean): void {
    if (coinId === this.lastSyncedCoinId) return;

    this.lastSyncedCoinId = coinId;
    this.customMode.set(custom);
  }

  /** The user chose "Other" in the select. */
  enterCustomMode(): void {
    this.customMode.set(true);
  }

  /** The user chose a real option in the select. */
  leaveCustomMode(): void {
    this.customMode.set(false);
  }

  /** Value for the <select>: the sentinel in custom mode, so it reads "Other". */
  selectValue(fieldValue: string): string {
    return this.customMode() ? CUSTOM_OPTION_SENTINEL : fieldValue;
  }
}
