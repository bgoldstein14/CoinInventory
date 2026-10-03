import { Component, computed, effect, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NumericField } from '../../directives/numeric-field';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { formatDenominationDisplay, formatMeltValue } from '../../types/inventory-columns';
import { CustomOptionMode, CUSTOM_OPTION_SENTINEL, isKnownOptionValue, stripCustomSentinel } from './custom-option-mode';
import { denominationCountriesOf } from './denomination-countries';

/**
 * CoinEditorForm — the grid of editable fields inside the detail sidebar
 * (year, denomination, grade, prices, certification, notes, and so on).
 *
 * WHY THIS FILE EXISTS
 * This is the single biggest chunk of markup in the app. Keeping it apart from
 * CoinDetailPanel means the panel stays a readable twenty-line frame, and all
 * the "how do I display a price in a text box" plumbing lives in one obvious
 * place.
 *
 * HOW SAVING WORKS
 * There is no Save button. Every field writes straight back to the coin via
 * `InventoryService.updateCoin()`, which debounces and batches the changes
 * before sending them to the server. That is why each control is bound with a
 * one-way `[ngModel]` plus an explicit `(ngModelChange)` handler rather than
 * two-way `[(ngModel)]`: the coin record is the single source of truth, and the
 * input is only ever a view of it.
 *
 * Each write carries ONE field. That is a hard rule, not a style preference —
 * a wider payload has previously overwritten fields the user never touched.
 *
 * TWO THINGS IN HERE ARE SUBTLER THAN THEY LOOK
 *  1. the "Other" denomination / mint mark text boxes — see custom-option-mode.ts
 *  2. the numeric inputs                              — see directives/numeric-field.ts
 * Both were real, reported, data-losing bugs. Read those two files before
 * changing how either works.
 */
@Component({
  selector: 'app-coin-editor-form',
  imports: [FormsModule, NumericField],
  templateUrl: './coin-editor-form.html',
  styleUrl: './coin-editor-form.scss'
})
export class CoinEditorForm {
  private readonly inventoryService = inject(InventoryService);
  protected get inv() { return this.inventoryService; }

  /** The coin being edited. */
  readonly coin = input.required<CoinRecord>();

  /** The Metal dropdown's options, kept in sync with the database lookup list. */
  protected readonly metalContentOptions = this.inventoryService.metalContents;

  protected formatDenominationDisplay = formatDenominationDisplay;

  // =========================================================================
  // "Other" (custom) denomination and mint mark
  // -------------------------------------------------------------------------
  // The mechanics, and the bug they fix, are documented in full in
  // custom-option-mode.ts. The short version: whether the free-text box is open
  // is its OWN state, held below, and is never inferred from the field's value
  // while the user is editing. '__OTHER__' exists only as an <option> value and
  // is never written to a coin.
  // =========================================================================

  /** Exposed so the template's <option value="..."> matches what we check for. */
  protected readonly CUSTOM_OPTION_SENTINEL = CUSTOM_OPTION_SENTINEL;

  protected readonly denominationMode = new CustomOptionMode();
  protected readonly mintMarkMode = new CustomOptionMode();

  /**
   * The denomination labels currently offered by the select.
   *
   * This is the list custom mode is judged against: a stored denomination that
   * is NOT in here must be something the user typed, so the custom box has to
   * reopen holding it. Inactive rows are excluded because the template does not
   * render them either — if they were counted, a retired denomination would
   * look "known" and its box would stay shut with no way to see the value.
   */
  protected readonly activeDenominationLabels = computed(() =>
    this.inv.denominations().filter(d => d.isActive).map(d => d.label)
  );

  /** Same idea for mint marks. */
  protected readonly activeMintMarkLabels = computed(() =>
    this.inv.mintMarks().filter(m => m.isActive).map(m => m.label)
  );

  /**
   * The country groups the denomination dropdown renders, DERIVED from the
   * denominations themselves rather than hard-coded.
   *
   * WHY THIS IS A COMPUTED AND NOT A LITERAL
   * The template used to loop a fixed `['US', 'GB']`. That had two failure
   * modes, and the owner hit the first one:
   *
   *   1. If anything set a denomination's country to a value outside that
   *      pair, its <optgroup> matched nothing and the dropdown rendered a
   *      list of empty group headings — country names with no entries under
   *      them. The Settings dialog was doing exactly that, stamping every
   *      denomination with 'United States'.
   *   2. The Categories & Sets dialog lets you add a denomination for 'CA',
   *      which the hard-coded list did not include, so such a denomination
   *      could be created and then never appear.
   *
   * Deriving the groups from the data makes both impossible: a group exists
   * if and only if some active denomination belongs to it, so there can never
   * be an empty heading and never an unreachable entry.
   *
   * US sorts first because this is a US collection and it is the overwhelming
   * majority of the list; everything else follows alphabetically.
   */
  /**
   * The melt figure for this coin, ready to drop into the pricing row.
   *
   * A `computed()`, which is what makes it keep itself up to date. It reads
   * two signals — the `coin` input and, inside InventoryService.meltValue(),
   * the `spotPrices` signal — so Angular re-evaluates it both when the user
   * edits the coin's PM weight or metal AND when fresh spot prices arrive,
   * with no subscription or manual refresh anywhere.
   *
   * The arithmetic is NOT repeated here. It is computeMeltValue(), reached
   * through InventoryService.meltValue(), and that is the only copy of it in
   * the app. In particular purity is NOT applied on top: pmWeightGrams is
   * already the weight of the pure metal. See inventory-metrics.ts.
   */
  protected readonly meltValueDisplay = computed(() =>
    formatMeltValue(this.inv.meltValue(this.coin()))
  );

  /** Tooltip explaining the figure — above all, why it is a dash when it is. */
  protected readonly meltValueHint = computed(() => this.inv.meltValueHint(this.coin()));

  protected readonly denominationCountries = computed(() =>
    denominationCountriesOf(this.inv.denominations())
  );

  constructor() {
    // Re-derive custom mode when a coin is loaded.
    //
    // This effect fires on EVERY coin change, including the user's own
    // keystrokes, because the coin signal gets a new identity on each edit.
    // CustomOptionMode.syncForCoin is what makes that safe: it ignores the call
    // unless the coin id actually changed. Without that guard, typing a custom
    // denomination that happens to match a real option would close the box
    // mid-word. Do not "simplify" this into a computed().
    effect(() => {
      const coin = this.coin();
      this.denominationMode.syncForCoin(coin.id, coin.denomination, this.activeDenominationLabels());
      this.mintMarkMode.syncForCoin(coin.id, coin.mintMark, this.activeMintMarkLabels());
    });
  }

  /**
   * The user picked something in the Denomination select.
   *
   * Picking "Other" is a pure UI action: it opens the box and saves nothing,
   * EXCEPT that a previously-picked real denomination is cleared — the user has
   * just said "it is none of these", so leaving "$1" sitting in the box would
   * be wrong. A value that was already custom is left alone so re-opening the
   * select does not wipe the text.
   */
  protected onDenominationSelected(value: string): void {
    if (value === CUSTOM_OPTION_SENTINEL) {
      this.denominationMode.enterCustomMode();
      if (isKnownOptionValue(this.coin().denomination, this.activeDenominationLabels())) {
        this.updateSelectedCoin('denomination', '');
      }
      return;
    }

    this.denominationMode.leaveCustomMode();
    this.updateSelectedCoin('denomination', value);
  }

  /** Identical handling for Mint mark — same bug, same mechanism, no one-offs. */
  protected onMintMarkSelected(value: string): void {
    if (value === CUSTOM_OPTION_SENTINEL) {
      this.mintMarkMode.enterCustomMode();
      if (isKnownOptionValue(this.coin().mintMark, this.activeMintMarkLabels())) {
        this.updateSelectedCoin('mintMark', '');
      }
      return;
    }

    this.mintMarkMode.leaveCustomMode();
    this.updateSelectedCoin('mintMark', value);
  }

  // =========================================================================
  // Saving
  // =========================================================================

  /**
   * Write one field back to the coin.
   *
   * Certification companies are short codes (NGC, PCGS, ANACS...), so that one
   * field is trimmed to five characters and upper-cased as you type.
   *
   * Denomination and mint mark are run through `stripCustomSentinel` as a
   * safety net. Nothing above should ever hand us '__OTHER__', but this is the
   * one funnel every edit passes through, so it is the right place to make the
   * guarantee absolute: that string can never be persisted.
   */
  protected updateSelectedCoin<K extends keyof CoinRecord>(field: K, value: CoinRecord[K]): void {
    const coin = this.coin();

    let nextValue = value;
    if (field === 'certCompany') {
      nextValue = String(value ?? '').slice(0, 5).toUpperCase() as CoinRecord[K];
    } else if (field === 'denomination' || field === 'mintMark') {
      nextValue = stripCustomSentinel(value as string) as CoinRecord[K];
    }

    this.inv.updateCoin(coin.id, { [field]: nextValue } as Partial<CoinRecord>);
  }

  /**
   * Bridge between the NumericField directive and a non-nullable number column.
   *
   * The directive reports `null` while the box is empty so that it can tell
   * "being cleared" apart from "deliberately zero" and leave the text alone.
   * Every numeric column on a coin is a NOT NULL number, though, so what we
   * actually store for an empty box is 0. The user's half-typed text is still
   * untouched on screen — only the saved value is normalised.
   */
  protected updateNumericField<K extends keyof CoinRecord>(field: K, value: number | null): void {
    this.updateSelectedCoin(field, (value ?? 0) as CoinRecord[K]);
  }

  /** The CAC "green bean" sticker is a simple yes/no on the coin. */
  protected toggleCacSticker(): void {
    const coin = this.coin();
    this.inv.updateCoin(coin.id, { hasCacSticker: !coin.hasCacSticker });
  }
}
