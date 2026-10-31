import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppSettings } from '../../features/app-settings';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import {
  PmBackfillOutcome,
  PmBackfillPlan,
  PmBackfillProgress
} from '../../services/pm-backfill';

/**
 * SettingsModal — the Settings dialog: one display preference plus the five
 * editable reference lists (categories, denominations, mint marks, metals and
 * sets/albums).
 *
 * WHY THIS FILE EXISTS
 * Reference-list maintenance was roughly a third of the App component. None of
 * it is needed until the user opens Settings, and none of it is interesting to
 * anything else on the page.
 *
 * ---------------------------------------------------------------------------
 * ONE EDITING STYLE: THE CHIPS. THE BULK TEXTAREAS ARE GONE.
 * ---------------------------------------------------------------------------
 * Each list used to be editable two ways — chips that applied immediately, and
 * a newline-separated textarea underneath applied on Save. The owner found the
 * textareas redundant, and they were also the source of a family of bugs,
 * because a reference record is not just its label and rebuilding one from a
 * line of text threw away everything else:
 *
 *   * DENOMINATIONS lost their country. Rebuilt rows were stamped
 *     'United States' while the data uses 'US' and 'GB', and the coin editor
 *     groups its dropdown by that value — so one press of Save produced a
 *     denomination dropdown showing country headings with nothing under them.
 *   * DENOMINATION AND MINT MARK IDS were renumbered from line position, so
 *     they stopped matching the database rows they stand for and a later
 *     delete could target the wrong record.
 *   * DENOMINATION LABELS were read back from DISPLAY text: the textarea was
 *     filled via formatDenominationDisplay, which rewrites '1/-' as '1 sh', so
 *     saving stored the prettified string as the real label.
 *   * CATEGORIES, METALS AND MINT MARKS were applied with a plain signal.set(),
 *     which changed the in-memory list and never told the backend, so a bulk
 *     edit silently reverted on the next reload.
 *
 * The chips have none of those problems: they add and remove one entry at a
 * time through InventoryService, which persists each change and leaves every
 * other field of the record alone. Deleting the textareas removed the bugs
 * rather than patching them.
 *
 * WHAT "SAVE" DOES NOW
 * Only the display preference. Every list edit has already been applied and
 * persisted by the time you press it — which is why Cancel does not undo them,
 * and never did.
 */
@Component({
  selector: 'app-settings-modal',
  imports: [FormsModule],
  templateUrl: './settings-modal.html',
  styleUrl: './settings-modal.scss'
})
export class SettingsModal {
  private readonly inventoryService = inject(InventoryService);
  private readonly storageService = inject(StorageService);
  protected get inv() { return this.inventoryService; }

  /** Current value of the "show transactions" preference, owned by the App shell. */
  readonly showTransactionsInDetails = input.required<boolean>();

  /** Emitted as soon as the checkbox is ticked (the App shell keeps the value). */
  readonly showTransactionsInDetailsChange = output<boolean>();

  readonly closed = output<void>();

  // --- "Add one item" inputs, one per list ---
  protected readonly categoryDraft = signal('');
  protected readonly denominationDraft = signal('');
  protected readonly mintMarkDraft = signal('');
  protected readonly metalContentDraft = signal('');
  protected readonly coinSetDraft = signal('');

  // ===================== Save =====================

  /**
   * Persists the display preference and closes.
   *
   * The reference lists are deliberately absent: the chips apply and persist
   * each change as it is made, so there is nothing left here to commit.
   */
  protected saveSettings(): void {
    // MERGE, don't replace. StorageKeys.AppSettings is a single shared object
    // and this modal is not its only writer — the batch image import saves the
    // photo base folder into it too (see
    // services/image-import/import-base-folder.ts). Writing a freshly built
    // object here would silently delete that folder, so the stored value is
    // read back and only the fields this screen owns are overwritten.
    void this.saveAppSettings();
    this.closed.emit();
  }

  /** Read-modify-write of the shared preferences object. See saveSettings(). */
  private async saveAppSettings(): Promise<void> {
    const existing = await this.storageService.get<AppSettings>(StorageKeys.AppSettings);
    const settings: AppSettings = {
      ...(existing ?? {}),
      showTransactionsInDetails: this.showTransactionsInDetails()
    };
    await this.storageService.set(StorageKeys.AppSettings, settings);
  }

  // ===================== Categories =====================

  protected addCategory(): void {
    const draft = this.categoryDraft().trim();
    if (!draft) return;
    this.inv.mergeCategoryOptions([draft]);
    this.categoryDraft.set('');
  }

  protected removeCategory(category: string): void {
    this.inv.removeCategoryOption(category);
  }

  // ===================== Denominations =====================

  protected addDenomination(): void {
    const label = this.denominationDraft().trim();
    if (!label) return;

    // Put the new denomination at the end of the sort order, leaving a gap of
    // 10 so future entries can be slotted in between without renumbering.
    const nextSortOrder = Math.max(0, ...this.inv.denominations().map(d => d.sortOrder)) + 10;

    // 'US', not 'United States'. The seeded data uses the short code (see the
    // Denominations block in server/setup-database.sql) and the coin editor
    // groups its dropdown by this value, so a full country name here would
    // file the new entry under a group of its own. Use the Categories & Sets
    // dialog to add one for another country — it has a country picker.
    void this.inv.addDenomination({
      label,
      country: 'US',
      sortOrder: nextSortOrder,
      isActive: true
    });

    this.denominationDraft.set('');
  }

  protected removeDenominationEntry(id: number): void {
    void this.inv.removeDenomination(id);
  }

  // ===================== Mint marks =====================

  protected addMintMark(): void {
    const label = this.mintMarkDraft().trim();
    if (!label) return;

    void this.inv.addMintMark({
      label,
      description: label,
      isActive: true
    });

    this.mintMarkDraft.set('');
  }

  protected removeMintMarkEntry(id: number): void {
    void this.inv.removeMintMark(id);
  }

  // ===================== Metal content =====================

  protected addMetalContent(): void {
    const value = this.metalContentDraft().trim();
    if (!value) return;

    const next = [...new Set([...this.inv.metalContents(), value])].sort((left, right) => left.localeCompare(right));
    this.inv.metalContents.set(next);
    this.metalContentDraft.set('');
  }

  protected removeMetalContent(value: string): void {
    this.inv.metalContents.set(this.inv.metalContents().filter(item => item !== value));
  }

  // ===================== Sets / Albums =====================
  //
  // These are the values offered by the "Set / Album" picker in the coin
  // detail panel. Add and remove go through InventoryService (and therefore
  // LookupManager), which updates the signal AND persists to `/api/coin-sets`.
  // Until recently that write never happened and a newly added set disappeared
  // on the next reload.

  protected addCoinSet(): void {
    const name = this.coinSetDraft().trim();
    if (!name) return;

    this.inv.addCoinSet(name);
    this.coinSetDraft.set('');
  }

  protected removeCoinSet(name: string): void {
    this.inv.removeCoinSet(name);
  }

  /* =========================================================================
   * MAINTENANCE — backfill precious-metal data
   * -------------------------------------------------------------------------
   * WHY THIS LIVES IN SETTINGS
   *
   * It is a one-off, app-wide housekeeping job, not a per-coin edit. Settings
   * is already where app-wide housekeeping lives, it is the only dialog the
   * user opens expecting to change many things at once, and it is deliberately
   * out of the way -- which suits an action that rewrites part of several
   * hundred rows. The coin detail panel would have been wrong: it edits ONE
   * coin, and a button there that quietly touched four hundred others would be
   * a trap. It sits in its own bordered section, below the reference lists, so
   * it cannot be mistaken for one of them.
   *
   * -------------------------------------------------------------------------
   * PREVIEW, THEN CONFIRM, THEN REPORT
   *
   * Three states, in order, and the user has to press a button between each:
   *
   *   1. idle      -- a "Preview" button and an explanation.
   *   2. previewed -- the counts, plus Run and Cancel. The counts are not an
   *                   estimate: `plan.candidates` is the exact list of writes
   *                   that Run then performs, so what is promised and what
   *                   happens cannot disagree.
   *   3. done      -- what actually changed, including any failures.
   *
   * Nothing is written before step 2's confirm. The preview is pure.
   * ======================================================================= */

  /** The pending plan: non-null means the preview is on screen. */
  protected readonly backfillPlan = signal<PmBackfillPlan | null>(null);

  /** True while the writes are going out, so the buttons can be disabled. */
  protected readonly backfillRunning = signal(false);

  /** Live "coin 37 of 212" progress. Null when nothing is running. */
  protected readonly backfillProgress = signal<PmBackfillProgress | null>(null);

  /** The end-of-run report. Null until a run has finished. */
  protected readonly backfillOutcome = signal<PmBackfillOutcome | null>(null);

  /**
   * Work out what WOULD happen. Reads the inventory and writes nothing.
   *
   * Re-running it is free and always safe, which is why there is no guard
   * against pressing Preview twice.
   */
  protected previewPmBackfill(): void {
    this.backfillOutcome.set(null);
    this.backfillProgress.set(null);
    this.backfillPlan.set(this.inv.planPmBackfill());
  }

  /** Throw the preview away without writing anything. */
  protected cancelPmBackfill(): void {
    this.backfillPlan.set(null);
    this.backfillProgress.set(null);
  }

  /**
   * THE CONFIRM. Write exactly the plan that is on screen.
   *
   * The run is sequential and each write is awaited -- see
   * `runPmBackfill` in pm-backfill.ts for why a plain loop over the ordinary
   * debounced `updateCoin` would fire every request at once instead.
   *
   * The plan is cleared only after the run finishes, so the progress line can
   * keep showing the total it was working towards.
   */
  protected async confirmPmBackfill(): Promise<void> {
    const plan = this.backfillPlan();
    if (!plan || plan.fillableCount === 0 || this.backfillRunning()) return;

    this.backfillRunning.set(true);
    this.backfillProgress.set({ total: plan.fillableCount, processed: 0, currentLabel: '' });

    try {
      const outcome = await this.inv.runPmBackfill(plan, (progress) =>
        this.backfillProgress.set(progress)
      );
      this.backfillOutcome.set(outcome);
    } finally {
      // `finally`, so a thrown error cannot strand the dialog with its buttons
      // disabled for ever. `runPmBackfill` collects per-coin failures rather
      // than throwing, so reaching here by exception would be a bug elsewhere.
      this.backfillRunning.set(false);
      this.backfillPlan.set(null);
      this.backfillProgress.set(null);
    }
  }
}
