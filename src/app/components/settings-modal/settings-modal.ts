import { Component, inject, input, output, signal } from '@angular/core';
import { AppSettings } from '../../features/app-settings';
import { InventoryService } from '../../services/inventory.service';
import { StorageKeys, StorageService } from '../../services/storage.service';
import {
  PmBackfillOutcome,
  PmBackfillPlan,
  PmBackfillProgress
} from '../../services/pm-backfill';

/**
 * SettingsModal — the Settings dialog: settings, and nothing else.
 *
 * *** NO REFERENCE LIST IS EDITED HERE, AND NONE MAY COME BACK. ***
 * This dialog used to carry chip editors for categories, mint marks, metal
 * content and sets/albums. Three of those were a SECOND editor for a list
 * the Reference Data screen (components/category-modal) already owned, and
 * two editors for one list is how the two drift: the chips removed an entry
 * on one click with no in-use count and no question, while the pane two
 * clicks away named the number of coins affected and asked first. The weaker
 * editor silently won whenever somebody happened to open this dialog.
 *
 * Metal content was the one list with no pane over there, so it was MOVED
 * (see the Metal Content section of category-modal.ts), not dropped. What is
 * left here is a button that opens that screen, because a user who learned
 * these lists lived in Settings has to be taken to the new place rather than
 * left to search for it.
 *
 * WHAT IS LEFT, AND WHY EACH ONE BELONGS
 *   - "Show transactions section in details": a display preference. It
 *     changes what this application shows, not what the collection contains.
 *   - Maintenance > backfill precious-metal data: a one-off, app-wide
 *     housekeeping job over the coin records. See the note above the
 *     backfill methods for why it is not in the coin editor.
 *
 * WHAT "SAVE" DOES
 * Only the display preference — it is now the only thing this dialog holds
 * that is not applied the moment it is pressed.
 */
@Component({
  selector: 'app-settings-modal',
  imports: [],
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

  /**
   * "Open Reference Data" — the single route to the lists that used to be
   * edited here.
   *
   * An OUTPUT rather than a modal opened from inside this component,
   * because the App shell owns which dialog is on screen; it closes this
   * one as it opens the other, so the two overlays can never stack.
   */
  readonly referenceDataRequested = output<void>();

  // ===================== Save =====================

  /**
   * Persists the display preference and closes.
   *
   * The display preference is the only thing there is to commit: the
   * reference lists are no longer edited here at all.
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

  /*
   * MAINTENANCE — backfill precious-metal data.
   *
   * WHY THIS LIVES IN SETTINGS. It is a one-off, app-wide housekeeping job,
   * not a per-coin edit. The coin detail panel would have been wrong: it
   * edits ONE coin, and a button there that quietly touched several hundred
   * others would be a trap. It sits in its own bordered section, below the
   * signpost to Reference Data, so it cannot be mistaken for a list to type
   * into — which was the original reason for the rule-off border, back when
   * the chip editors were above it.
   *
   * PREVIEW, THEN CONFIRM, THEN REPORT. Three states, in order, with a button
   * press between each:
   *
   *   1. idle      -- a "Preview" button and an explanation.
   *   2. previewed -- the counts, plus Run and Cancel. The counts are not an
   *                   estimate: `plan.candidates` is the exact list of writes
   *                   that Run then performs, so what is promised and what
   *                   happens cannot disagree.
   *   3. done      -- what actually changed, including any failures.
   *
   * Nothing is written before step 2's confirm. The preview is pure.
   */

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
