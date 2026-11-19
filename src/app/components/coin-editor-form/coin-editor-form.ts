import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NumericField } from '../../directives/numeric-field';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CATALOG_NUMBER_MAX_LENGTH, CatalogRef } from '../../types/catalog-reference';
import { singleLine } from './wrapping-field';
import { gradeEdit, hasGrade } from '../../types/cac-sticker';
import {
  CatalogPickerOption,
  CatalogRefRowPatch,
  addCatalogRefRow,
  catalogPickerOptions,
  removeCatalogRefRow,
  updateCatalogRefRow
} from './catalog-ref-rows';
import { COLLECTION_STATUS_OPTIONS, normalizeCollectionStatus } from '../../types/collection-status';
import { formatDenominationDisplay, formatMeltValue } from '../../types/inventory-columns';
import { allCountryNames } from '../../services/coin-countries';
import { CustomOptionMode, CUSTOM_OPTION_SENTINEL, isKnownOptionValue, stripCustomSentinel } from './custom-option-mode';
import { denominationChoiceUpdates } from './country-denomination-link';
import { denominationDisplay } from '../../services/denominations/denomination-display';
import {
  customDenominationWrites,
  denominationPickerBase,
  denominationPickerView,
  denominationSelectionFor
} from './denomination-picker';
import {
  AutofillKeyField,
  describePmAutofillConflicts,
  planPmAutofill,
  pmAutofillWrites
} from '../../services/pm-autofill';
import { confirmOverwrite } from '../../features/confirm-action';

/**
 * Editable field grid inside the detail sidebar.
 *
 * There is no Save button: each control is one-way bound and writes a single field
 * through InventoryService.updateCoin(), which debounces and batches. Always write
 * one field at a time so unrelated fields are never overwritten.
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

  /**
   * Settings > "Show transactions section in details". The section renders here because it sits
   * above this component's Notes box. Not required so specs can omit it.
   */
  readonly showTransactions = input(false);

  /** The Metal dropdown's options, kept in sync with the database lookup list. */
  protected readonly metalContentOptions = this.inventoryService.metalContents;

  protected formatDenominationDisplay = formatDenominationDisplay;

  // "Other" (custom) denomination and mint mark; see custom-option-mode.ts.

  /** Exposed for the template's "Other…" option. */
  protected readonly CUSTOM_OPTION_SENTINEL = CUSTOM_OPTION_SENTINEL;

  protected readonly denominationMode = new CustomOptionMode();
  protected readonly mintMarkMode = new CustomOptionMode();

  /** The mint mark labels currently offered by the select. */
  protected readonly activeMintMarkLabels = computed(() =>
    this.inv.mintMarks().filter(m => m.isActive).map(m => m.label)
  );

  /** Exposed so the number input's maxlength matches the NVARCHAR(50) column. */
  protected readonly CATALOG_NUMBER_MAX_LENGTH = CATALOG_NUMBER_MAX_LENGTH;

  /** Keeps the wrapping textareas (Year, Coin Type, custom mint mark) to one stored line. */
  protected readonly singleLine = singleLine;


  /** The coin's catalogue references, one editor row each. */
  protected readonly catalogRefs = computed(() => this.coin().catalogRefs ?? []);

  /** The picker options for one reference row. */
  protected catalogOptionsFor(ref: CatalogRef): CatalogPickerOption[] {
    return catalogPickerOptions(this.inv.catalogs(), ref);
  }

  /** A row's select value as a string ('' for "(none)"); a number would match no option. */
  protected catalogIdForSelect(ref: CatalogRef): string {
    return ref.catalogId === null || ref.catalogId === undefined ? '' : String(ref.catalogId);
  }

  // Denomination picker; see denomination-picker.ts.

  /**
   * Denomination search text. Local UI state only, kept separate from the coin so typing
   * re-runs only the cheap filtering step.
   */
  private readonly denominationQuerySignal = signal('');
  protected readonly denominationQuery = this.denominationQuerySignal.asReadonly();

  /**
   * Which denomination option this coin is on (by id, else resolved from its text), and
   * whether the custom box applies. Display only; nothing is saved.
   */
  protected readonly denominationSelection = computed(() =>
    denominationSelectionFor(
      this.coin().denominationId,
      this.coin().denomination,
      this.coin().country,
      this.inv.denominations()
    )
  );

  /**
   * Expensive part of the picker. Deliberately independent of the search text so typing
   * only re-runs denominationView.
   */
  protected readonly denominationBase = computed(() =>
    denominationPickerBase(
      this.inv.denominations(),
      this.coin().country,
      this.denominationSelection().denominationId
    )
  );

  /** The groups the <select> renders, with the search box applied. */
  protected readonly denominationView = computed(() =>
    denominationPickerView(this.denominationBase(), this.denominationQuery())
  );

  /** The denomination select's value: the id as a string. */
  protected readonly denominationSelectValue = computed(() => {
    const id = this.denominationSelection().denominationId;
    return id === null ? '' : String(id);
  });

  /** Display text for the custom box hint. Uses denominationDisplay(), the single source of that rule. */
  protected readonly denominationDisplayText = computed(() =>
    denominationDisplay(this.denominationSelection().label, this.coin().denomination)
  );

  /** Formatted melt value. Updates when the coin or spot prices change. */
  protected readonly meltValueDisplay = computed(() =>
    formatMeltValue(this.inv.meltValue(this.coin()))
  );

  /** Tooltip explaining the melt figure, including why it is a dash. */
  protected readonly meltValueHint = computed(() => this.inv.meltValueHint(this.coin()));

  /** Status options, shared with the filter bar. */
  protected readonly collectionStatusOptions = COLLECTION_STATUS_OPTIONS;

  /**
   * Status select value. Coins with no status show as 'owned' (an undefined value would
   * render blank). Read-only: nothing is written back for display.
   */
  protected readonly statusForSelect = computed(() =>
    normalizeCollectionStatus(this.coin().collectionStatus)
  );

  // Country/denomination linking: see country-denomination-link.ts.

  /**
   * Country suggestions for the <datalist>. Country stays free text because existing values
   * can be anything.
   */
  protected readonly countrySuggestions = allCountryNames();

  constructor() {
    // Fires on every edit (the coin signal changes identity), so each step below is guarded
    // by coin id. Do not turn this into a computed().
    effect(() => {
      const coin = this.coin();

      // Wait for lookups: deciding before they load would mark every coin custom.
      const selection = this.denominationSelection();
      if (selection.ready) {
        this.denominationMode.syncWhenReady(coin.id, selection.custom);
      }

      this.mintMarkMode.syncForCoin(coin.id, coin.mintMark, this.activeMintMarkLabels());

      // Clear the search when a different coin is selected.
      if (coin.id !== this.lastSearchedCoinId) {
        this.lastSearchedCoinId = coin.id;
        this.denominationQuerySignal.set('');
      }
    });
  }

  /** Coin the current search text belongs to. */
  private lastSearchedCoinId: string | null = null;

  /** The user typed in the denomination search box. Saves nothing. */
  protected onDenominationSearch(value: string): void {
    this.denominationQuerySignal.set(value ?? '');
  }

  /**
   * Denomination selected. Option values are ids (labels like 'Crown' are not unique).
   * Writes the id and label as separate single-field updates. "Other" opens the custom
   * box and clears the id.
   */
  protected onDenominationSelected(value: string): void {
    if (value === CUSTOM_OPTION_SENTINEL) {
      this.denominationMode.enterCustomMode();

      // customDenominationWrites decides what to clear; the user's own text is kept.
      for (const write of customDenominationWrites(this.denominationSelection(), this.coin().denomination)) {
        this.updateSelectedCoin(write.field, write.value as CoinRecord[typeof write.field]);
      }
      return;
    }

    this.denominationMode.leaveCustomMode();

    const chosen = this.inv.denominations()
      .find(denomination => denomination.isActive && String(denomination.denominationId) === value);

    if (!chosen) {
      // "(select)" or an unknown id: clear both fields together.
      this.updateSelectedCoin('denominationId', null);
      this.updateSelectedCoin('denomination', '');
      return;
    }

    this.updateSelectedCoin('denominationId', chosen.denominationId);

    // Label text, plus Country when it is blank. Computed from one snapshot of the coin.
    // A label shared by several issuers sets no country.
    const updates = denominationChoiceUpdates(chosen.label, this.coin().country, this.inv.denominations());
    for (const update of updates) {
      this.updateSelectedCoin(update.field, update.value);
    }

    // Reset the search once a choice is made.
    this.denominationQuerySignal.set('');

    // A select change is already a commit, so run the autofill now. The new values are passed in
    // because the coin() input does not update within this handler.
    const committed: Partial<CoinRecord> = { denominationId: chosen.denominationId };
    for (const update of updates) committed[update.field] = update.value;
    this.autofillAfterKeyChange(updates.map(u => u.field), committed);
  }

  /** Metal selected. Also re-runs the autofill, since metal can resolve otherwise ambiguous coins. */
  protected onMetalContentSelected(value: string): void {
    this.updateSelectedCoin('metalContent', value);
    this.autofillAfterKeyChange(['metalContent'], { metalContent: value });
  }

  /** Adds an empty reference row. It is saved once it has a number. */
  protected addCatalogRef(): void {
    this.updateSelectedCoin('catalogRefs', addCatalogRefRow(this.catalogRefs()));
  }

  /** Removes a reference; removing the last one clears the coin's references. */
  protected removeCatalogRef(index: number): void {
    this.updateSelectedCoin('catalogRefs', removeCatalogRefRow(this.catalogRefs(), index));
  }

  /** Changes one reference's catalogue or number. */
  protected updateCatalogRef(index: number, patch: CatalogRefRowPatch): void {
    this.updateSelectedCoin('catalogRefs', updateCatalogRefRow(this.catalogRefs(), index, patch));
  }

  /** Mint mark selected; same custom-mode handling as denomination. */
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

  // ---- Saving ----

  /**
   * Certification company is upper-cased and capped at five characters. Denomination and
   * mint mark are stripped of the "Other" sentinel so it can never be saved.
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

  /** Stores an empty numeric box as 0 (the columns are NOT NULL); the on-screen text is left alone. */
  protected updateNumericField<K extends keyof CoinRecord>(field: K, value: number | null): void {
    this.updateSelectedCoin(field, (value ?? 0) as CoinRecord[K]);
  }

  // Metal / weight autofill; rules live in services/pm-autofill.ts.

  /**
   * A key text field was committed (bound to (change), i.e. on blur), so re-run the autofill.
   * Using (change) rather than (ngModelChange) avoids inferring from half-typed values.
   */
  protected onKeyFieldCommitted(field: AutofillKeyField): void {
    this.autofillAfterKeyChange([field]);
  }

  /**
   * Re-run the autofill and apply its writes.
   *
   * @param changed Key fields the user just committed; the planner never writes back to them.
   * @param committed New values from the same handler, since coin() has not updated yet.
   */
  private autofillAfterKeyChange(
    changed: readonly AutofillKeyField[],
    committed?: Partial<CoinRecord>
  ): void {
    const coin = this.coin();
    const plan = planPmAutofill({ ...coin, ...(committed ?? {}) }, { changed });

    if (!plan.hasWork) return;

    // Only prompt when the plan would overwrite existing values.
    const accepted = plan.needsConfirmation
      ? confirmOverwrite(describePmAutofillConflicts(plan.conflicts))
      : false;

    const writes = pmAutofillWrites(plan, accepted);

    // One field per write.
    for (const [field, value] of Object.entries(writes)) {
      this.updateSelectedCoin(field as keyof CoinRecord, value as CoinRecord[keyof CoinRecord]);
    }
  }

  protected readonly hasGrade = hasGrade;

  /** Grade edited; clearing it also clears the CAC sticker. */
  protected onGradeChanged(grade: string): void {
    this.inv.updateCoin(this.coin().id, gradeEdit(grade, this.coin().hasCacSticker));
  }

  /** Toggles the CAC sticker flag. */
  protected toggleCacSticker(): void {
    const coin = this.coin();
    this.inv.updateCoin(coin.id, { hasCacSticker: !coin.hasCacSticker });
  }
}
