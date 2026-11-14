import { Component, computed, inject, input, OnDestroy, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AppSettings } from '../../features/app-settings';
import { ApiService } from '../../services/api.service';
import {
  BackupFileEntry,
  BackupInspection,
  RestoreResult,
  describeBackupBlock,
  describeBackupContents,
  describeBackupFile,
  describeFolderListing,
  describePhotoWarning,
  describeRestoreBlock,
  describeRestoreConsequence,
  describeRestoreOutcome,
  formatBytes
} from '../../services/backup/backup-messages';
import { BackupFolderBrowser } from '../../services/backup/backup-folder-browser';
import { BackupRunner, messageFrom } from '../../services/backup/backup-runner';
import {
  clampMaxStoredImageBytes,
  describeBytes,
  DEFAULT_IMAGE_STORAGE_SETTINGS,
  loadImageStorageSettings,
  MAX_STORED_IMAGE_BYTES_CAP,
  MIN_STORED_IMAGE_BYTES,
  normalizeImageStorageMode,
  type ImageStorageMode
} from '../../services/image-import/image-storage-settings';
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
 * AND NO SIGNPOST TO IT EITHER, ANY MORE. A "Reference data" notice with an
 * "Open Reference Data" button lived here for a day and was removed at the
 * owner's word: *"not really needed since there's an obvious button already
 * on screen."* It is not to come back in a smaller form — a one-line link is
 * the same signpost in a lower-contrast font. The toolbar button is the route.
 *
 * WHAT IS LEFT, AND WHY EACH ONE BELONGS
 *   - "Show transactions section in details": a display preference. It
 *     changes what this application shows, not what the collection contains.
 *   - Photographs: where imported pictures are kept, and how big the stored
 *     copy may be. A DATA decision, not a performance one — see
 *     services/image-import/image-storage-settings.ts.
 *   - Maintenance > backfill precious-metal data: a one-off, app-wide
 *     housekeeping job over the coin records. See the note above the
 *     backfill methods for why it is not in the coin editor.
 *   - Backup and restore (§16): write the whole collection to a file the
 *     user chooses, and replace it from one. It is the same KIND of thing
 *     as the backfill — app-wide, one-off, acts when pressed — and it
 *     belongs behind Settings for exactly the reason the backfill does:
 *     it is not a per-coin action and a button for it anywhere near the
 *     grid would be a trap. See the backup section below.
 *
 * WHAT "SAVE" DOES
 * The display preference and the two photograph settings. Everything else on
 * this screen acts the moment it is pressed.
 */
@Component({
  selector: 'app-settings-modal',
  imports: [],
  templateUrl: './settings-modal.html',
  styleUrl: './settings-modal.scss'
})
export class SettingsModal implements OnDestroy {
  private readonly inventoryService = inject(InventoryService);
  private readonly storageService = inject(StorageService);
  private readonly api = inject(ApiService);
  protected get inv() { return this.inventoryService; }

  /** Current value of the "show transactions" preference, owned by the App shell. */
  readonly showTransactionsInDetails = input.required<boolean>();

  /** Emitted as soon as the checkbox is ticked (the App shell keeps the value). */
  readonly showTransactionsInDetailsChange = output<boolean>();

  readonly closed = output<void>();

  /* ===================== Photographs =====================
   *
   * TWO SETTINGS, ONE OF WHICH IS A DATA DECISION.
   *
   * MODE. 'stored' downscales the picture into the database; 'referenced'
   * records only where the file is. The downscaled copy is NOT a cache — it
   * is the only thing that survives the user moving or deleting the
   * original (design §4.4/§4.9) — so this radio decides whether the
   * application keeps its own copy of the user's photographs at all. The
   * screen says that in those words rather than talking about disk space.
   *
   * CHANGING IT CONVERTS NOTHING. Photographs already imported are left
   * exactly as they are; the choice applies to the next import. The template
   * states this next to the radios, because a setting that silently
   * rewrote 2,000 existing rows either way would be the worst thing on this
   * screen. (Converting what already exists is the §4.9a backfill — a
   * separate, long-running job with progress and cancellation, deliberately
   * not built here.)
   *
   * MAXIMUM SIZE. Shown and entered in MB, held in bytes, and it measures
   * THE COPY THIS APP STORES — never the user's own file, which is never
   * modified and never refused for being large. Capped at 10 MB.
   *
   * Loaded here rather than passed in from the App shell, unlike the
   * transactions preference above: nothing outside this dialog and the
   * import needs these values, so routing them through the shell would add
   * two inputs and two outputs to say nothing new.
   */

  /** Where imported pictures go. Null until the stored value has loaded. */
  protected readonly imageStorageMode = signal<ImageStorageMode>(
    DEFAULT_IMAGE_STORAGE_SETTINGS.mode
  );

  /** The stored-copy budget, in BYTES (the box shows MB). */
  protected readonly maxStoredImageBytes = signal<number>(
    DEFAULT_IMAGE_STORAGE_SETTINGS.maxStoredImageBytes
  );

  /** The number in the box: megabytes, to one decimal. */
  protected readonly maxStoredImageMb = computed(() =>
    Math.round((this.maxStoredImageBytes() / (1024 * 1024)) * 10) / 10
  );

  /** "1 MB" — what the budget currently works out to, spelled out. */
  protected readonly maxStoredImageLabel = computed(() =>
    describeBytes(this.maxStoredImageBytes())
  );

  /** The cap, in MB, for the input's `max` attribute and the hint text. */
  protected readonly maxStoredImageMbCap = MAX_STORED_IMAGE_BYTES_CAP / (1024 * 1024);

  /** The floor, in MB, for the input's `min`. */
  protected readonly minStoredImageMb =
    Math.round((MIN_STORED_IMAGE_BYTES / (1024 * 1024)) * 100) / 100;

  /**
   * Has the user touched either photograph control yet?
   *
   * The saved values arrive asynchronously, a moment after the dialog is on
   * screen. Somebody who clicks a radio inside that window would otherwise
   * have their click silently undone by the load landing on top of it —
   * rare, invisible, and exactly the kind of thing that gets reported as
   * "the setting does not stick". The late answer is dropped instead.
   */
  private photoSettingsTouched = false;

  constructor() {
    // Fire-and-forget: the controls start on the defaults, which are the
    // app's long-standing behaviour, and settle on the saved values a moment
    // later. A failed read leaves the defaults showing rather than an error.
    void loadImageStorageSettings(this.storageService).then(settings => {
      if (this.photoSettingsTouched) return;
      this.imageStorageMode.set(settings.mode);
      this.maxStoredImageBytes.set(settings.maxStoredImageBytes);
    });

    // Where a backup should go, and how big this collection is. Same
    // fire-and-forget contract: a failure leaves the boxes empty.
    this.loadBackupSuggestion();
  }

  protected setImageStorageMode(mode: string): void {
    this.photoSettingsTouched = true;
    this.imageStorageMode.set(normalizeImageStorageMode(mode));
  }

  /**
   * The size box changed. The value is clamped on the way IN as well as on
   * the way out, so the hint under the box always describes what would
   * actually be saved rather than what was typed.
   */
  protected setMaxStoredImageMb(value: string): void {
    this.photoSettingsTouched = true;
    const mb = Number(value);
    this.maxStoredImageBytes.set(
      clampMaxStoredImageBytes(Number.isFinite(mb) ? mb * 1024 * 1024 : NaN)
    );
  }

  // ===================== Save =====================

  /**
   * Persists the display preference and the two photograph settings, then
   * closes. The reference lists are not edited here at all.
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
      showTransactionsInDetails: this.showTransactionsInDetails(),
      // Re-normalised on the way out as well as on the way in: the box is a
      // text field and the mode arrives as a string from the DOM.
      imageStorageMode: normalizeImageStorageMode(this.imageStorageMode()),
      maxStoredImageBytes: clampMaxStoredImageBytes(this.maxStoredImageBytes())
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

  /* ===================== BACKUP AND RESTORE — §16 =====================
   *
   * *** THE FRAMING IS PORTABILITY, NOT JUST SAFEKEEPING. *** The owner's
   * words: "allows the database to essentially be portable...another
   * feature essentially." A backup is restored on the same machine by the
   * same build; a PORTABLE file is opened on another PC, possibly by
   * another build, possibly next year. That is a harder requirement and it
   * is what shapes everything below — the version check, the
   * what-is-in-this-file panel, and the warning about photographs that do
   * not travel.
   *
   * ---- GETTING A PATH INTO A BOX, WITH A BROWSER THAT WILL NOT HELP ----
   *
   * A browser will not tell JavaScript where a file really is. A directory
   * picker gives only `File.webkitRelativePath`; a file input gives a
   * `File` with no path at all. The server is the thing that must write
   * and read these files — a multi-gigabyte database cannot sensibly be
   * streamed through the browser and back — so it needs a real path on the
   * host.
   *
   * Three ways to produce one, all three on this screen, in increasing
   * order of how far they can be trusted:
   *
   *   TYPE OR PASTE   always available and never to be removed: it is the
   *                   only thing that reaches a UNC path to a NAS.
   *   PICK A FOLDER   narrows the guess. A pick yields the folder's NAME
   *                   and nothing else, so the rest is assumed from what
   *                   the box already held and the UI says so in those
   *                   words. The batch image import's pattern exactly
   *                   (services/image-import/source-path.ts), including
   *                   the server-side prefill from a real folder on this
   *                   machine — the Desktop.
   *   ASK THE SERVER  the server CAN read a directory even though the
   *                   browser cannot. GET /api/backup/files lists the
   *                   `*.db` files actually in a folder, which is both
   *                   how the restore file gets chosen without typing
   *                   and how a wrong guess above is caught before
   *                   anything is replaced.
   *
   * ---- THREE PANELS, AND THE MIDDLE ONE IS THE SAFETY FEATURE ----
   *
   *   BACK UP    folder + name, a progress bar, a Cancel button, and the
   *              finished file's full path.
   *   CHECK      what is in the file the user has pointed at: coin count,
   *              when it was taken, and whether its photographs will work
   *              on this machine. Changes nothing.
   *   RESTORE    only reachable from CHECK, and only when CHECK said yes.
   *
   * It is the Preview → Confirm shape the backfill above already uses, and
   * here it matters far more: the backfill fills in blanks, this replaces
   * a collection. Nothing is moved until the user has seen what is in the
   * file and pressed a second button.
   */

  /* ---- CHOOSING A FOLDER, AND WHAT A PICKER CAN AND CANNOT DO ----
   *
   * The owner's words after testing the first build: *"the folder text
   * boxes should allow for a directory search box, like how Image
   * imports work. Plus for the restore, it should use a *.db search of
   * files for it's directory search box so a file can be selected."*
   *
   * Both are now here, and the honest description of each is:
   *
   *   THE FOLDER PICKER NARROWS A GUESS; IT DOES NOT PRODUCE A PATH.
   *   A browser will not tell a page where a folder is — it reports only
   *   the files inside it and their path RELATIVE to it — so all a pick
   *   yields is the folder's NAME. picked-folder.ts assumes it sits
   *   inside whatever the box already held and SAYS SO on screen,
   *   naming both halves. This is the image import's pattern
   *   (image-import-modal.html's header, source-path.ts), not a second
   *   invention.
   *
   *   THE FILE LIST IS REAL, BECAUSE THE SERVER LOOKS. The browser
   *   cannot read a folder; the server already reads these files for a
   *   living. GET /api/backup/files returns the `*.db` files actually in
   *   a named folder with a size and a date, so the restore is a choice
   *   from what is there rather than an exact path typed from memory.
   *   It is also what settles the picker's guess: a wrong folder comes
   *   back as "there is no folder called ..." or as an empty list,
   *   before anything is written or replaced.
   *
   * TYPING STILL WORKS, EVERYWHERE. Both boxes stay ordinary text
   * inputs. Somebody pasting a UNC path to a NAS that no picker on this
   * machine can reach must not be blocked by a convenience.
   */

  /** The backup half's folder box, its picker and its listing. */
  protected readonly backupFolder = new BackupFolderBrowser((directory) =>
    firstValueFrom(this.api.listBackupFiles(directory))
  );

  /**
   * The folder the backup goes in. Prefilled by the server.
   *
   * The same signal the browser above owns, aliased so the rest of this
   * class and the template read it under the name they always have.
   */
  protected readonly backupDirectory = this.backupFolder.folder;

  /** The file name. Prefilled with today's suggestion. */
  protected readonly backupFileName = signal('');

  /** Size of the collection, so "this writes 600 MB" is known in advance. */
  protected readonly databaseSizeLabel = signal<string | null>(null);

  /**
   * The polling job watcher. A plain object, not a signal, so it is
   * created once; `backupTick` below is what makes the template redraw.
   */
  protected readonly backup = new BackupRunner({
    start: (directory, fileName) => firstValueFrom(this.api.startBackup(directory, fileName)),
    poll: (id) => firstValueFrom(this.api.getBackupJob(id)),
    cancel: (id) => firstValueFrom(this.api.cancelBackup(id)),
    onChange: () => this.backupTick.update((n) => n + 1)
  });

  /**
   * Bumped on every change the runner reports.
   *
   * The runner is a plain class and knows nothing about signals — that is
   * deliberate, because it is what lets it be tested without Angular. The
   * template reads this counter inside the computed getters below, so a
   * change to the runner's state is what triggers the redraw.
   */
  private readonly backupTick = signal(0);

  protected readonly backupMessage = computed(() => {
    this.backupTick();
    return this.backup.message;
  });

  protected readonly backupPercent = computed(() => {
    this.backupTick();
    return this.backup.percent;
  });

  protected readonly backupRunning = computed(() => {
    this.backupTick();
    return this.backup.running;
  });

  protected readonly backupCanCancel = computed(() => {
    this.backupTick();
    return this.backup.canCancel;
  });

  /** The finished file's full path. The most useful line on the panel. */
  protected readonly backupPath = computed(() => {
    this.backupTick();
    return this.backup.result?.path ?? null;
  });

  protected setBackupDirectory(value: string): void {
    // Through the browser, not the signal, so a list of files from the
    // previous folder cannot be left sitting under a path that has since
    // been edited.
    this.backupFolder.setFolder(value);
  }

  protected setBackupFileName(value: string): void {
    this.backupFileName.set(value);
  }

  /**
   * *** WHY "BACK UP NOW" IS OFF, IN WORDS, NEXT TO THE BUTTON. ***
   *
   * A disabled button with no explanation is what made the first build
   * of this panel unusable (see describeRestoreBlock). The same courtesy
   * is owed here even though the folder is normally prefilled, because
   * the one time it is empty is when the server could not be reached —
   * exactly when the user has least idea what is going on.
   *
   * The METHOD below is deliberately not guarded by this. Whether a
   * destination is usable is settled by backup/names.ts on the server,
   * which answers with a sentence the panel shows verbatim; a second
   * rule here could only ever disagree with it.
   */
  protected readonly backupBlockReason = computed(() =>
    describeBackupBlock(this.backupDirectory(), this.backupRunning())
  );

  /** The one-line summary of what is in the backup folder, if asked. */
  protected readonly backupFolderSummary = computed(() =>
    describeFolderListing(this.backupFolder.listing())
  );

  /**
   * The directory picker came back for the BACKUP box.
   *
   * `input.value = ''` afterwards so choosing the same folder twice
   * fires `change` again — without it a user correcting a mistyped
   * prefix by re-picking the same folder gets silence.
   */
  protected handleBackupFolderPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.backupFolder.acceptPick(Array.from(input.files ?? []));
    input.value = '';
  }

  /** Ask the server what is already in the backup folder. */
  protected async listBackupFolder(): Promise<void> {
    await this.backupFolder.refresh();
  }

  protected async startBackup(): Promise<void> {
    await this.backup.run(this.backupDirectory(), this.backupFileName());
  }

  protected async cancelBackup(): Promise<void> {
    await this.backup.requestCancel();
  }

  /**
   * Stops polling when the dialog goes away.
   *
   * It does NOT cancel the backup: closing a dialog is not a decision to
   * abandon a nine-minute copy, and there is a Cancel button for people
   * who mean that. Without this, a closed dialog would leave a timer
   * firing a request every 400 ms for the rest of the session.
   */
  ngOnDestroy(): void {
    this.backup.dispose();
  }

  // ---- Restoring ----

  /**
   * The folder to LOOK IN, which is a different question from which file
   * to restore and is asked first.
   *
   * Prefilled with the same folder the backup half suggests, because the
   * overwhelmingly likely answer is "the place my backups go".
   */
  protected readonly restoreFolder = new BackupFolderBrowser((directory) =>
    firstValueFrom(this.api.listBackupFiles(directory))
  );

  /**
   * The path that will actually be restored: chosen from the list, typed,
   * or pasted.
   *
   * *** IT IS STILL A TEXT BOX AND THAT IS NOT A LEFTOVER. *** The list
   * can only show folders the server can reach and the user can name. A
   * UNC path to a NAS, a drive the picker will not open, a path out of
   * an email — all of those must still work, and the only thing that
   * makes them work is being able to paste.
   */
  protected readonly restorePath = signal('');

  /** What the server found in it. Null until "Check this file" is pressed. */
  protected readonly inspection = signal<BackupInspection | null>(null);

  /** True while either half of the restore is in flight. */
  protected readonly inspecting = signal(false);
  protected readonly restoring = signal(false);

  /** A failure of the REQUEST, as opposed to a refusal of the file. */
  protected readonly restoreError = signal<string | null>(null);

  /** The completed restore. Non-null means the collection has changed. */
  protected readonly restoreOutcome = signal<RestoreResult | null>(null);

  protected setRestorePath(value: string): void {
    this.restorePath.set(value);
    // Any edit invalidates the previous answer. Leaving a green "this is a
    // valid backup of 412 coins" panel on screen above a path that now
    // points somewhere else is how the wrong file gets restored.
    this.inspection.set(null);
    this.restoreError.set(null);
  }

  /**
   * *** WHY "CHECK THIS FILE" IS OFF, IN WORDS, NEXT TO THE BUTTON. ***
   *
   * THE BUG THIS FIXES, in the owner's words: *"It wasn't intuitive how
   * to do the restore because the watermarked restore field looked like
   * it was filled in text and it could leave the user bewildered why the
   * buttons weren't enabled."*
   *
   * Two faults compounding. A grey example path inside an empty box
   * reads as a VALUE — so the user believed the field was set — and a
   * disabled button offers no contradiction, so nothing on screen could
   * correct the belief. Styling the empty state alone would fix only the
   * first; this is the second, and it names the grey text explicitly
   * because the belief is what has to be contradicted.
   *
   * The wording lives in backup-messages.ts, like every other sentence
   * in this feature, so it is tested rather than painted.
   */
  protected readonly restoreBlockReason = computed(() =>
    describeRestoreBlock(this.restorePath(), this.inspecting(), this.restoring())
  );

  /** True when the box is genuinely empty, so it can be drawn as empty. */
  protected readonly restorePathEmpty = computed(() => this.restorePath().trim().length === 0);

  /** The summary line above the file list: how many, or that there are none. */
  protected readonly restoreFolderSummary = computed(() =>
    describeFolderListing(this.restoreFolder.listing())
  );

  /**
   * The files to offer, each with its "612.3 MB · 14 Nov 2026, 16:20".
   *
   * Formatted once here rather than from the template, for the reason
   * image-import-modal.ts gives for `nearChips`: a method call in a
   * template runs on every change-detection pass.
   */
  protected readonly restoreFolderFiles = computed(() =>
    (this.restoreFolder.listing()?.files ?? []).map((file) => ({
      path: file.path,
      name: file.name,
      detail: describeBackupFile(file)
    }))
  );

  /** The directory picker came back for the RESTORE folder box. */
  protected handleRestoreFolderPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.restoreFolder.acceptPick(Array.from(input.files ?? []));
    input.value = '';
  }

  /** Ask the server for the *.db files really in that folder. */
  protected async listRestoreBackups(): Promise<void> {
    await this.restoreFolder.refresh();
  }

  /**
   * The user picked one of the listed files.
   *
   * It fills the path box and NOTHING ELSE — no automatic inspection and
   * certainly no restore. The two deliberate presses stay two deliberate
   * presses; the list has removed the typing, not a safeguard.
   */
  protected chooseBackupFile(entry: Pick<BackupFileEntry, 'path'>): void {
    this.setRestorePath(entry.path);
  }

  /** The verdict sentence, whether it was a yes or a no. */
  protected readonly inspectionMessage = computed(
    () => this.inspection()?.decision.message ?? null
  );

  protected readonly inspectionAcceptable = computed(
    () => this.inspection()?.decision.acceptable === true
  );

  /** The "what is in this file" lines. Empty for a refused file. */
  protected readonly backupContents = computed(() => describeBackupContents(this.inspection()));

  /** "Restoring will replace..." — the two facts a user will not infer. */
  protected readonly restoreConsequence = computed(() =>
    describeRestoreConsequence(this.inspection())
  );

  /** *** THE PHOTOGRAPH WARNING. *** Null when there is nothing to say. */
  protected readonly photoWarning = computed(() => {
    const inspection = this.inspection();
    if (!inspection) return null;
    return describePhotoWarning(
      inspection.referencedOnlyImageCount,
      inspection.referencedFolders
        .filter((entry) => !entry.presentOnThisMachine)
        .map((entry) => entry.folder)
    );
  });

  /** What to say once it is done, including where the old collection is. */
  protected readonly restoreOutcomeLines = computed(() => {
    const outcome = this.restoreOutcome();
    return outcome ? describeRestoreOutcome(outcome) : [];
  });

  /** The same warning again, after the fact, so it is not just remembered. */
  protected readonly restoredPhotoWarning = computed(() => {
    const outcome = this.restoreOutcome();
    if (!outcome) return null;
    return describePhotoWarning(outcome.referencedOnlyImageCount, outcome.missingPhotoFolders);
  });

  /** LOOK. Changes nothing, on the server or here. */
  protected async checkBackupFile(): Promise<void> {
    const path = this.restorePath().trim();
    if (path.length === 0 || this.inspecting()) return;

    this.inspecting.set(true);
    this.restoreError.set(null);
    this.inspection.set(null);

    try {
      this.inspection.set(await firstValueFrom(this.api.inspectBackup(path)));
    } catch (err) {
      this.restoreError.set(messageFrom(err));
    } finally {
      this.inspecting.set(false);
    }
  }

  /**
   * THE CONFIRM. Only reachable once the inspection has said yes, and the
   * server validates the file again for itself before touching anything —
   * so this guard is a UI courtesy, not the protection.
   */
  protected async confirmRestore(): Promise<void> {
    const path = this.restorePath().trim();
    if (!this.inspectionAcceptable() || this.restoring() || path.length === 0) return;

    this.restoring.set(true);
    this.restoreError.set(null);

    try {
      this.restoreOutcome.set(await firstValueFrom(this.api.restoreBackup(path)));
      this.inspection.set(null);
    } catch (err) {
      this.restoreError.set(messageFrom(err));
    } finally {
      this.restoring.set(false);
    }
  }

  /**
   * Reloads the page so the app reads the collection that is now there.
   *
   * *** NO SERVER RESTART IS NEEDED AND THE APP DOES NOT RESTART ITSELF. ***
   * The backend closed its handle for the swap and reopens the file on the
   * next request (db/pool.ts, withDatabaseOffline), so the API is already
   * serving the restored collection. What is stale is THIS page: the grid,
   * the lookups and the totals were all loaded into memory from the old
   * one. A reload is the complete and honest fix, and it is a BUTTON
   * rather than something that happens automatically, because yanking the
   * page out from under somebody who is still reading where their previous
   * collection went is exactly the wrong moment to do it.
   */
  protected reloadAfterRestore(): void {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  }

  /**
   * Asks the server where to put a backup and how big the collection is.
   *
   * Fire-and-forget from the constructor, like the photograph settings
   * above: a failure leaves the boxes empty, which the panel handles, and
   * is a far better outcome than a dialog that will not open.
   */
  private loadBackupSuggestion(): void {
    void firstValueFrom(this.api.getBackupSuggestion())
      .then((suggestion) => {
        // Only prefill boxes the user has not already typed into. The
        // answer arrives a moment after the dialog is on screen, and
        // overwriting a path somebody has just pasted is the same bug the
        // photograph settings guard against above.
        if (this.backupDirectory().length === 0) this.backupDirectory.set(suggestion.directory);
        if (this.backupFileName().length === 0) this.backupFileName.set(suggestion.fileName);
        // The RESTORE half gets the same folder, for the same reason it
        // is offered to the backup half: it is where this app puts
        // backups, so it is where the user's backups almost certainly
        // are. It only seeds the "look in" box — the file itself is
        // still chosen, and the path box stays empty until it is.
        if (this.restoreFolder.folder().length === 0) {
          this.restoreFolder.folder.set(suggestion.directory);
        }
        this.databaseSizeLabel.set(
          suggestion.databaseSizeBytes === null ? null : formatBytes(suggestion.databaseSizeBytes)
        );
      })
      .catch(() => {
        // Nothing to say. The boxes stay empty and the panel's own hint
        // explains what to type.
      });
  }
}
