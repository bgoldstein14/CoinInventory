import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NumericField } from '../../directives/numeric-field';
import { InventoryService } from '../../services/inventory.service';
import { CoinRecord } from '../../types/coin.model';
import { CATALOG_NUMBER_MAX_LENGTH } from '../../types/catalog-reference';
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
 * CoinEditorForm — the grid of editable fields inside the detail sidebar
 * (year, denomination, grade, prices, certification, notes, and so on).
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
 * Two things in here are subtler than they look, and both lose data when got
 * wrong. Read the file before changing either:
 *  1. the "Other" denomination / mint mark text boxes — custom-option-mode.ts
 *  2. the numeric inputs                              — directives/numeric-field.ts
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

  // "Other" (custom) denomination and mint mark. The mechanics are documented
  // in full in custom-option-mode.ts. The short version: whether the free-text
  // box is open is its OWN state, held below, and is never inferred from the
  // field's value while the user is editing. '__OTHER__' exists only as an
  // <option> value and is never written to a coin.

  /** Exposed so the template's <option value="..."> matches what we check for. */
  protected readonly CUSTOM_OPTION_SENTINEL = CUSTOM_OPTION_SENTINEL;

  protected readonly denominationMode = new CustomOptionMode();
  protected readonly mintMarkMode = new CustomOptionMode();

  /** The mint mark labels currently offered by the select. */
  protected readonly activeMintMarkLabels = computed(() =>
    this.inv.mintMarks().filter(m => m.isActive).map(m => m.label)
  );

  // The catalogue reference — "Sear 6819". Two controls on the certification
  // row: which catalogue, and the number within it. The rules all live in
  // types/catalog-reference.ts; this component only binds them. Nothing here
  // looks anything up — see the template comment for why there is no resolver.

  /** Exposed so the number input's maxlength matches the NVARCHAR(50) column. */
  protected readonly CATALOG_NUMBER_MAX_LENGTH = CATALOG_NUMBER_MAX_LENGTH;

  /**
   * The catalogues the picker offers: the active ones, in the order the server
   * sent them (seeded order, so Sear leads).
   *
   * Inactive rows are excluded for the same reason the mint mark list excludes
   * them — a removed catalogue must not be offered again. A coin still
   * POINTING at a removed one is unaffected: catalogNameById() answers for
   * inactive rows, so the grid keeps reading "Sear 6819".
   */
  protected readonly activeCatalogs = computed(() =>
    this.inv.catalogs().filter(catalog => catalog.isActive)
  );

  /**
   * Which option the catalogue <select> should be sitting on, as a STRING.
   *
   * A <select>'s value is always a string, and `[value]="catalog.catalogId"`
   * renders the number as one. Binding the raw number here would match no
   * option and the control would render blank — and a blank dropdown invites
   * the user to "fix" a field that was never wrong, one stray click away from
   * writing a catalogue he did not mean.
   *
   * `?? ''` is the "(none)" option, which is a real and extremely common
   * answer here rather than a missing value.
   */
  protected readonly catalogIdForSelect = computed(() => {
    const id = this.coin().catalogId;
    return id === null || id === undefined ? '' : String(id);
  });

  // THE DENOMINATION PICKER. 1,161 denominations under 61 issuers. All of the
  // reasoning — how the coin's country biases the list without limiting it,
  // what "Other" means now that text with no id is the normal outcome of an
  // import, and why the work is split in two for performance — is in
  // denomination-picker.ts. Read it before changing anything here; this
  // component only binds it.

  /**
   * What the user has typed into the denomination search box.
   *
   * *** A LOCAL UI SIGNAL, NOT A COIN FIELD. *** Searching is not editing:
   * nothing here is saved, and the signal is deliberately separate from the
   * coin so that a keystroke in it re-runs ONLY the cheap half of the picker.
   */
  private readonly denominationQuerySignal = signal('');
  protected readonly denominationQuery = this.denominationQuerySignal.asReadonly();

  /**
   * Which denomination this coin is on, and whether the custom box is open.
   *
   * The id wins when there is one. Otherwise the recorded text is put through
   * the same resolver the migrations and the importers use, which is what
   * keeps a coin reading '$1', '3CS' or '8 Reales' sitting on its real option.
   * NOTHING HERE WRITES: a resolution is shown, never saved.
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
   * The expensive half of the picker, in its own computed() ON PURPOSE.
   *
   * It depends on the lookup list, the coin's country and the coin's
   * denomination — and NOT on the search box. That separation is the
   * performance design: a keystroke in the search box re-runs only
   * `denominationView` below, which is a substring test per row. See the
   * header of denomination-picker.ts.
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

  /**
   * What the <select> should be sitting on: the id, as a string.
   *
   * The same string-valued-<select> rule as `catalogIdForSelect` above:
   * binding the raw number would match no option, and the control would render
   * blank on a coin that HAS a denomination.
   */
  protected readonly denominationSelectValue = computed(() => {
    const id = this.denominationSelection().denominationId;
    return id === null ? '' : String(id);
  });

  /**
   * The coin's denomination in words, for the hint beside the custom box.
   *
   * *** CALLS denominationDisplay(). DOES NOT REIMPLEMENT IT. *** That
   * function is the only place the display rule may be written, and its spec
   * greps the whole of src/ and fails the build if a second copy appears —
   * two copies are a FORK, not a duplicate, and the same coin then reads two
   * ways on two screens with nothing failing.
   */
  protected readonly denominationDisplayText = computed(() =>
    denominationDisplay(this.denominationSelection().label, this.coin().denomination)
  );

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

  // Collection status. The five states a coin can be in, and why they are
  // those five, are in types/collection-status.ts.

  /** The five choices, in declared order. One list, shared with the filter bar. */
  protected readonly collectionStatusOptions = COLLECTION_STATUS_OPTIONS;

  /**
   * Which option the Status select should be sitting on.
   *
   * *** NEVER BIND `coin().collectionStatus` DIRECTLY. *** A coin saved before
   * the status column existed has no status at all, and an `undefined` bound
   * into a <select> matches no <option>, so the control renders BLANK. A blank
   * dropdown reads as "this field is empty and I should fill it in", and it is
   * one stray click away from writing a value the user did not intend.
   *
   * normalizeCollectionStatus() resolves absent, empty and unrecognised alike
   * to 'owned', which is what those coins ARE, so the control opens on the
   * truth and writes nothing until the user picks something.
   *
   * It is deliberately READ-ONLY: nothing here saves 'owned' back onto a coin
   * that merely lacked a status. The database migration does that once,
   * properly, for every row at a time — a UI component quietly rewriting
   * records just because they were displayed is how edit histories become
   * useless.
   */
  protected readonly statusForSelect = computed(() =>
    normalizeCollectionStatus(this.coin().collectionStatus)
  );

  // Country <-> Denomination, the two-way link. All the reasoning, including
  // why 'GB' and 'Great Britain' need a bridge before they can be compared at
  // all, is in country-denomination-link.ts. Read that before changing
  // anything here.

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

      // Denomination no longer asks "is the value in the list?" — see
      // denomination-picker.ts on what "Other" means once a coin can hold
      // text with no id. `ready` is the lookups-have-arrived guard: deciding
      // before the server has answered would call every coin custom, and this
      // fires once per coin, so it would then STAY custom.
      const selection = this.denominationSelection();
      if (selection.ready) {
        this.denominationMode.syncWhenReady(coin.id, selection.custom);
      }

      this.mintMarkMode.syncForCoin(coin.id, coin.mintMark, this.activeMintMarkLabels());

      // A SEARCH BELONGS TO THE COIN THE USER TYPED IT FOR. Carrying 'reales'
      // over to the next coin would leave its dropdown narrowed to a row that
      // has nothing to do with it, and the user would have no idea why.
      // Guarded on the id for the same reason the custom-mode derivation is:
      // this effect fires on every keystroke in every field, and clearing the
      // box on each of them would make it impossible to type in.
      if (coin.id !== this.lastSearchedCoinId) {
        this.lastSearchedCoinId = coin.id;
        this.denominationQuerySignal.set('');
      }
    });
  }

  /** Which coin the search box currently belongs to. Bookkeeping, not state. */
  private lastSearchedCoinId: string | null = null;

  /** The user typed in the denomination search box. Saves nothing. */
  protected onDenominationSearch(value: string): void {
    this.denominationQuerySignal.set(value ?? '');
  }

  /**
   * The user picked something in the Denomination select.
   *
   * THE VALUE IS AN ID, NOT A LABEL. 'Crown' is a British coin and an
   * Australian one; a control keyed by label cannot tell which the user meant,
   * so every <option> carries `String(denominationId)`. The two values that
   * are NOT ids are the empty option and the custom sentinel, and neither can
   * collide with one.
   *
   * THE WRITE RULE: BOTH FIELDS, SET TO THE SAME DENOMINATION. Picking a
   * denomination writes the id AND the label as text, so the two agree from
   * then on. Only imports and deletions produce the divergent state, and that
   * state is visible by design rather than hidden.
   *
   * They go out as SEPARATE SINGLE-FIELD UPDATES, like everything else in this
   * component. A wider payload has previously overwritten fields the user
   * never touched, and the debounce coalesces them into one PUT anyway.
   *
   * PICKING "Other" is a mostly-UI action: it opens the box. It must also
   * CLEAR THE ID, because a custom value has no id by definition, and leaving
   * the old one behind would make the coin read as the denomination the user
   * just rejected. A real denomination they have just abandoned is cleared
   * from the text too; text they typed themselves is left alone so re-opening
   * the select does not wipe it.
   */
  protected onDenominationSelected(value: string): void {
    if (value === CUSTOM_OPTION_SENTINEL) {
      this.denominationMode.enterCustomMode();

      // The link always goes; the recorded text usually stays, because it is
      // what the SOURCE said and rejecting the link is not a reason to
      // destroy it. `customDenominationWrites` carries the full argument and
      // is where that decision is tested — this component only applies it,
      // one field per write like every other edit here.
      for (const write of customDenominationWrites(this.denominationSelection(), this.coin().denomination)) {
        this.updateSelectedCoin(write.field, write.value as CoinRecord[typeof write.field]);
      }
      return;
    }

    this.denominationMode.leaveCustomMode();

    const chosen = this.inv.denominations()
      .find(denomination => denomination.isActive && String(denomination.denominationId) === value);

    if (!chosen) {
      // The "(select)" option, or — defensively — an id the lookup no longer
      // has. BOTH fields are cleared together: leaving one behind is exactly
      // the divergence this rule exists to prevent on a deliberate action.
      this.updateSelectedCoin('denominationId', null);
      this.updateSelectedCoin('denomination', '');
      return;
    }

    this.updateSelectedCoin('denominationId', chosen.denominationId);

    // The text, plus the Country when (and only when) Country is blank. The
    // updates are worked out from ONE snapshot of the coin, before any of
    // them is applied, so the country decision cannot be confused by the
    // denomination write that precedes it.
    //
    // A label that two issuers share makes denominationChoiceUpdates decline
    // to infer a country, even though the id now says which issuer was meant.
    // Deliberately left that way: it writes nothing rather than something
    // wrong.
    const updates = denominationChoiceUpdates(chosen.label, this.coin().country, this.inv.denominations());
    for (const update of updates) {
      this.updateSelectedCoin(update.field, update.value);
    }

    // The search has done its job. Leaving it filled would make the control
    // look permanently narrowed to whatever was last looked for.
    this.denominationQuerySignal.set('');

    // A <select> firing is already a discrete "the user decided" event, so the
    // autofill runs straight off it rather than waiting for a blur.
    //
    // The committed values are SPLICED IN rather than re-read from `coin()`.
    // `coin` is an input signal and does not take on the new value inside the
    // same synchronous handler that wrote it, so reading it back here would
    // plan the autofill against the denomination the user has just replaced —
    // and the feature's whole purpose is to react to the new one.
    const committed: Partial<CoinRecord> = { denominationId: chosen.denominationId };
    for (const update of updates) committed[update.field] = update.value;
    this.autofillAfterKeyChange(updates.map(u => u.field), committed);
  }

  /**
   * The user picked a Metal.
   *
   * Worth its own handler rather than an inline `updateSelectedCoin` in the
   * template, because Metal is the one field that can turn an unanswerable
   * coin into an answerable one all by itself: an 1855 "$1" is a 26.73 g
   * silver dollar or a 1.672 g gold dollar, the reference table refuses to
   * choose between them, and the Metal picked here is the only evidence that
   * settles it. So saying "Gold" also fills in the composition, the purity
   * and both weights.
   */
  protected onMetalContentSelected(value: string): void {
    this.updateSelectedCoin('metalContent', value);
    this.autofillAfterKeyChange(['metalContent'], { metalContent: value });
  }

  /**
   * The user picked a catalogue (or "(none)").
   *
   * The value arrives from the <select> as a STRING, and what reaches the
   * record must be a NUMBER or undefined — `Coins.CatalogId` is an INT foreign
   * key, and a string bound to an INT parameter is the failure the normalizer
   * in server/db/coin-fields.ts had to be written for. Converting here as well
   * means the wire carries the right type in the first place.
   *
   * "(none)" writes `undefined`, not 0 and not null: undefined is how every
   * other optional field on CoinRecord says "not recorded", and 0 would be a
   * catalogue id that cannot exist (the column is IDENTITY, so ids start at 1)
   * while still looking like a value to anything testing truthiness.
   *
   * THE NUMBER IS DELIBERATELY LEFT ALONE when the catalogue changes. A user
   * correcting "Sear 6819" to "RIC 6819" is re-pointing the catalogue, not
   * discarding the number he just typed; clearing it would be this component
   * deciding his reference was wrong.
   */
  protected onCatalogSelected(value: string): void {
    const trimmed = (value ?? '').trim();
    const id = trimmed === '' ? undefined : Number(trimmed);

    this.updateSelectedCoin('catalogId', Number.isFinite(id as number) ? id : undefined);
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

  // ---- Saving ----

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

  // AUTOMATIC METAL / WEIGHT FILL. The rules live in services/pm-autofill.ts;
  // read that before changing anything here. Only the TRIGGER lives in this
  // component.

  /**
   * A free-text key field has been COMMITTED — re-run the metal / weight fill.
   *
   * WHY THIS IS BOUND TO `(change)` AND NOT TO `(ngModelChange)`
   *
   * `ngModelChange` fires on every keystroke. `change` is the native DOM
   * event, which a text box fires only when it LOSES FOCUS (or the user
   * presses Enter) AND the value is different from what it had when focus
   * arrived. That difference is the entire safety argument for this feature:
   *
   *   * THE RECORD IS NO LONGER BEING OBSERVED MID-SENTENCE. Typing "1879"
   *     one digit at a time does not produce four inferences; leaving the box
   *     produces one. The year "1" — which the coarse fallback will happily
   *     answer for, given a "$20" beside it — is never asked about.
   *
   *   * THE CARET HAS LEFT THE FIELD, so nothing is written into the record
   *     while the user is still inside a bound control. (The one field they
   *     might still be in, having pressed Enter, is the field we are forbidden
   *     from writing to anyway — see `changed`.)
   *
   *   * IT IS NOT A TIMER. Nothing here is scheduled, so nothing can fire at
   *     a moment the user did not choose.
   *
   * Saving is untouched: every keystroke still goes to `updateSelectedCoin`
   * and is still debounced by CoinEditor. This is a SECOND, independent
   * listener on the same control, not a replacement for the first.
   *
   * No argument is spliced in here, unlike the <select> paths: by the time a
   * blur happens, change detection has long since run and `coin()` holds the
   * committed value.
   */
  protected onKeyFieldCommitted(field: AutofillKeyField): void {
    this.autofillAfterKeyChange([field]);
  }

  /**
   * Re-run the inference and write what it is allowed to write.
   *
   * @param changed Which key field(s) the user just committed. Passed through
   *   to the planner, which uses it both to decide whether a COMPLETE coin is
   *   worth reconsidering and to make sure we never answer back about the
   *   very field that was typed.
   * @param committed The new values, for the callers that write and plan in
   *   the same tick. An Angular `input()` signal does not refresh inside the
   *   handler that wrote to it, so a <select> handler reading `coin()` would
   *   see the OLD denomination and infer the old coin all over again.
   */
  private autofillAfterKeyChange(
    changed: readonly AutofillKeyField[],
    committed?: Partial<CoinRecord>
  ): void {
    const coin = this.coin();
    const plan = planPmAutofill({ ...coin, ...(committed ?? {}) }, { changed });

    if (!plan.hasWork) return;

    // Only ask when there is genuinely a question. A plan with no conflicts
    // is written in silence — which is the normal case, and keeping it silent
    // is what stops the dialog from becoming something the user clicks away
    // without reading.
    const accepted = plan.needsConfirmation
      ? confirmOverwrite(describePmAutofillConflicts(plan.conflicts))
      : false;

    const writes = pmAutofillWrites(plan, accepted);

    // ONE FIELD PER WRITE. The same hard rule as every other edit in this
    // component: a wider payload has previously overwritten fields the user
    // never touched.
    for (const [field, value] of Object.entries(writes)) {
      this.updateSelectedCoin(field as keyof CoinRecord, value as CoinRecord[keyof CoinRecord]);
    }
  }

  /** The CAC "green bean" sticker is a simple yes/no on the coin. */
  protected toggleCacSticker(): void {
    const coin = this.coin();
    this.inv.updateCoin(coin.id, { hasCacSticker: !coin.hasCacSticker });
  }
}
