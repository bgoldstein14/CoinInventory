import { Component, computed, effect, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NumericField } from '../../directives/numeric-field';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { formatDenominationDisplay, formatMeltValue } from '../../types/inventory-columns';
import { allCountryNames } from '../../services/coin-countries';
import { CustomOptionMode, CUSTOM_OPTION_SENTINEL, isKnownOptionValue, stripCustomSentinel } from './custom-option-mode';
import { denominationChoiceUpdates, denominationOptionGroups } from './country-denomination-link';
import { resolveDenominationLabel } from './denomination-aliases';

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
   * The coin's denomination, expressed as one of the labels above when it is
   * one of them under a different spelling.
   *
   * THE BUG THIS FIXES — "the 1866 3CS comes up showing Other".
   * `Coins.Denomination` is free text and `Denominations.Label` is a short
   * canonical token, and the two were being compared with an exact,
   * case-sensitive string match. A coin stored as "Three Cent Silver",
   * "Trime" or even "3cs" therefore matched no option and was declared
   * custom. denomination-aliases.ts has the full account, including why the
   * answer is not "add those spellings to the lookup table".
   *
   * EVERY use of the denomination below goes through here rather than reading
   * `coin().denomination` directly, because all four are asking the same
   * question — "which option is this coin on?" — and two different answers to
   * it is how this component ends up showing a value it is not storing:
   *
   *   - the custom-mode derivation in the constructor
   *   - the <select>'s bound value, via `denominationMode.selectValue`
   *   - the option list, so an out-of-country alias is kept visible (Rule 2
   *     in country-denomination-link.ts)
   *   - the "did they just abandon a real denomination?" check when Other is
   *     picked
   *
   * Nothing here writes to the coin. The stored string stays exactly as it
   * is until the user picks a denomination themselves.
   */
  protected readonly denominationForSelect = computed(() => {
    const stored = this.coin().denomination;
    return resolveDenominationLabel(stored, this.activeDenominationLabels()) ?? stored;
  });

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

  // =========================================================================
  // Country <-> Denomination, the two-way link
  // -------------------------------------------------------------------------
  // All the reasoning, including why 'GB' and 'Great Britain' need a bridge
  // before they can be compared at all, is in country-denomination-link.ts.
  // Read that before changing anything here.
  // =========================================================================

  /**
   * The denomination dropdown's <optgroup>s, narrowed to the coin's country.
   *
   * A `computed()`, so it re-evaluates the moment the user edits the Country
   * box — Angular tracks both the `coin` input and the denominations lookup,
   * and nothing here has to subscribe to or refresh anything.
   *
   * It is pure display. Narrowing the list NEVER writes to the coin, so a
   * coin whose denomination falls outside the new filter keeps that value;
   * the helper keeps it in the list too, in a group of its own, so it stays
   * visible and selected rather than silently disappearing.
   */
  protected readonly denominationGroups = computed(() =>
    denominationOptionGroups(this.inv.denominations(), this.coin().country, this.denominationForSelect())
  );

  /**
   * Suggestions for the Country box, offered through a <datalist>.
   *
   * Country stays a FREE-TEXT input rather than becoming a <select>. The
   * column is unconstrained NVARCHAR and may already hold anything at all —
   * an import, a hand-typed historic issuer, a spelling this app has never
   * heard of — and a hard <select> would have no option to show for such a
   * value, so it would render blank and the next save would destroy it. A
   * datalist is the middle ground: the full list drops down and can be picked
   * or typed-ahead, but any other text is still accepted and still saved.
   *
   * It does not need to be a computed: the vocabulary is a compile-time
   * constant, so this is evaluated once when the component is created.
   */
  protected readonly countrySuggestions = allCountryNames();

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
      this.denominationMode.syncForCoin(coin.id, this.denominationForSelect(), this.activeDenominationLabels());
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
   *
   * Picking a REAL denomination may now also fill in the Country, but only
   * when Country is blank — see denominationChoiceUpdates(). The two writes
   * are deliberately looped rather than merged: every edit in this component
   * goes out as its own single-field update, and "the user's action changed
   * two fields" is not a licence to start sending wider payloads.
   */
  protected onDenominationSelected(value: string): void {
    if (value === CUSTOM_OPTION_SENTINEL) {
      this.denominationMode.enterCustomMode();
      if (isKnownOptionValue(this.denominationForSelect(), this.activeDenominationLabels())) {
        this.updateSelectedCoin('denomination', '');
      }
      return;
    }

    this.denominationMode.leaveCustomMode();

    // The updates are worked out from ONE snapshot of the coin, before any of
    // them is applied, so the country decision cannot be confused by the
    // denomination write that precedes it.
    const updates = denominationChoiceUpdates(value, this.coin().country, this.inv.denominations());
    for (const update of updates) {
      this.updateSelectedCoin(update.field, update.value);
    }
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
