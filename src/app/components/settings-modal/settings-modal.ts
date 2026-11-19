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
 * The Settings dialog: display preference, photograph storage, the
 * precious-metal backfill, and backup/restore.
 *
 * Reference lists (categories, mint marks, metal content, sets) are edited on
 * the Reference Data screen (category-modal), not here.
 *
 * Save persists the display preference and the two photograph settings;
 * everything else acts when pressed.
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

  /* ---- Photographs ----
   * 'stored' keeps a downscaled copy in the database; 'referenced' records only
   * the file path. Changing the mode affects future imports only. The size
   * limit applies to the stored copy, never to the user's own file.
   */

  /** Where imported pictures go. */
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

  /** The budget as a readable size, e.g. "1 MB". */
  protected readonly maxStoredImageLabel = computed(() =>
    describeBytes(this.maxStoredImageBytes())
  );

  /** The cap, in MB, for the input's `max` attribute and the hint text. */
  protected readonly maxStoredImageMbCap = MAX_STORED_IMAGE_BYTES_CAP / (1024 * 1024);

  /** The floor, in MB, for the input's `min`. */
  protected readonly minStoredImageMb =
    Math.round((MIN_STORED_IMAGE_BYTES / (1024 * 1024)) * 100) / 100;

  /** Set once the user changes a photograph control, so the async load doesn't overwrite it. */
  private photoSettingsTouched = false;

  constructor() {
    // Controls start on defaults and settle on the saved values once loaded.
    void loadImageStorageSettings(this.storageService).then(settings => {
      if (this.photoSettingsTouched) return;
      this.imageStorageMode.set(settings.mode);
      this.maxStoredImageBytes.set(settings.maxStoredImageBytes);
    });

    this.loadBackupSuggestion();
  }

  protected setImageStorageMode(mode: string): void {
    this.photoSettingsTouched = true;
    this.imageStorageMode.set(normalizeImageStorageMode(mode));
  }

  /** Clamps on input so the hint always shows what would actually be saved. */
  protected setMaxStoredImageMb(value: string): void {
    this.photoSettingsTouched = true;
    const mb = Number(value);
    this.maxStoredImageBytes.set(
      clampMaxStoredImageBytes(Number.isFinite(mb) ? mb * 1024 * 1024 : NaN)
    );
  }

  // ---- Save ----

  /** Persists the display preference and photograph settings, then closes. */
  protected saveSettings(): void {
    void this.saveAppSettings();
    this.closed.emit();
  }

  /**
   * Read-modify-write: AppSettings is shared (the image import stores its
   * base folder there too), so only this screen's fields are overwritten.
   */
  private async saveAppSettings(): Promise<void> {
    const existing = await this.storageService.get<AppSettings>(StorageKeys.AppSettings);
    const settings: AppSettings = {
      ...(existing ?? {}),
      showTransactionsInDetails: this.showTransactionsInDetails(),
      imageStorageMode: normalizeImageStorageMode(this.imageStorageMode()),
      maxStoredImageBytes: clampMaxStoredImageBytes(this.maxStoredImageBytes())
    };
    await this.storageService.set(StorageKeys.AppSettings, settings);
  }

  /* ---- Maintenance: precious-metal backfill ----
   * Preview (pure, writes nothing) -> confirm (writes exactly the previewed
   * candidates) -> report.
   */

  /** The pending plan: non-null means the preview is on screen. */
  protected readonly backfillPlan = signal<PmBackfillPlan | null>(null);

  /** True while the writes are going out, so the buttons can be disabled. */
  protected readonly backfillRunning = signal(false);

  /** Live "coin 37 of 212" progress. Null when nothing is running. */
  protected readonly backfillProgress = signal<PmBackfillProgress | null>(null);

  /** The end-of-run report. Null until a run has finished. */
  protected readonly backfillOutcome = signal<PmBackfillOutcome | null>(null);

  /** Computes what would be filled. Writes nothing. */
  protected previewPmBackfill(): void {
    this.backfillOutcome.set(null);
    this.backfillProgress.set(null);
    this.backfillPlan.set(this.inv.planPmBackfill());
  }

  /** Discards the preview without writing anything. */
  protected cancelPmBackfill(): void {
    this.backfillPlan.set(null);
    this.backfillProgress.set(null);
  }

  /**
   * Writes the previewed plan, one awaited request at a time (see
   * runPmBackfill in pm-backfill.ts).
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
      // Always re-enable the buttons, even on an unexpected error.
      this.backfillRunning.set(false);
      this.backfillPlan.set(null);
      this.backfillProgress.set(null);
    }
  }

  /* ---- Backup and restore ----
   * The server reads and writes the files, so it needs a real host path. The
   * browser cannot supply one: a folder pick yields only the folder name, so
   * the path is a guess (shown as such), and the text boxes stay editable for
   * typed or pasted paths such as UNC shares. The server lists *.db files in
   * a folder so the restore file can be chosen from what is actually there.
   *
   * Restore is two steps: Check (inspects, changes nothing) then Restore.
   */

  /** The backup folder box, its picker and its listing. */
  protected readonly backupFolder = new BackupFolderBrowser((directory) =>
    firstValueFrom(this.api.listBackupFiles(directory))
  );

  /** The folder the backup goes in (alias of backupFolder.folder). Prefilled by the server. */
  protected readonly backupDirectory = this.backupFolder.folder;

  /** The file name. Prefilled with today's suggestion. */
  protected readonly backupFileName = signal('');

  /** Size of the collection, so the backup size is known in advance. */
  protected readonly databaseSizeLabel = signal<string | null>(null);

  /** Polls the backup job; `backupTick` makes the template redraw on change. */
  protected readonly backup = new BackupRunner({
    start: (directory, fileName) => firstValueFrom(this.api.startBackup(directory, fileName)),
    poll: (id) => firstValueFrom(this.api.getBackupJob(id)),
    cancel: (id) => firstValueFrom(this.api.cancelBackup(id)),
    onChange: () => this.backupTick.update((n) => n + 1)
  });

  /**
   * Bumped on every runner change. The runner is a plain class (testable
   * without Angular), so the computeds below read this to stay reactive.
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

  /** The finished file's full path. */
  protected readonly backupPath = computed(() => {
    this.backupTick();
    return this.backup.result?.path ?? null;
  });

  protected setBackupDirectory(value: string): void {
    // Via the browser so a stale file listing is cleared when the path changes.
    this.backupFolder.setFolder(value);
  }

  protected setBackupFileName(value: string): void {
    this.backupFileName.set(value);
  }

  /**
   * Why "Back up now" is disabled, shown next to the button. Destination
   * validity is decided by the server, so startBackup() is not guarded by this.
   */
  protected readonly backupBlockReason = computed(() =>
    describeBackupBlock(this.backupDirectory(), this.backupRunning())
  );

  /** The one-line summary of what is in the backup folder, if asked. */
  protected readonly backupFolderSummary = computed(() =>
    describeFolderListing(this.backupFolder.listing())
  );

  /**
   * Directory picker result for the backup box. Clearing the input lets
   * picking the same folder again fire `change`.
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

  /** Stops polling when the dialog closes. Does not cancel a running backup. */
  ngOnDestroy(): void {
    this.backup.dispose();
  }

  // ---- Restoring ----

  /** The folder to look in for backups. Prefilled with the backup folder. */
  protected readonly restoreFolder = new BackupFolderBrowser((directory) =>
    firstValueFrom(this.api.listBackupFiles(directory))
  );

  /** The path to restore: chosen from the list, typed, or pasted. */
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
    // Any edit invalidates the previous inspection result.
    this.inspection.set(null);
    this.restoreError.set(null);
  }

  /** Why "Check this file" is disabled, shown next to the button. */
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
   * The files to offer, with size and date. Formatted here rather than in the
   * template to avoid a method call on every change-detection pass.
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

  /** Fills the path box from the list. Does not inspect or restore. */
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

  /** What restoring will replace, and where the current collection goes. */
  protected readonly restoreConsequence = computed(() =>
    describeRestoreConsequence(this.inspection())
  );

  /** Warning about referenced photographs missing on this machine. Null when none. */
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

  /** The photograph warning repeated after the restore. */
  protected readonly restoredPhotoWarning = computed(() => {
    const outcome = this.restoreOutcome();
    if (!outcome) return null;
    return describePhotoWarning(outcome.referencedOnlyImageCount, outcome.missingPhotoFolders);
  });

  /** Inspects the file. Changes nothing. */
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
   * Restores the inspected file. The server re-validates it, so this guard
   * is a UI courtesy, not the protection.
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
   * Reloads the page so it reads the restored collection. The server already
   * serves the new file; only this page's in-memory data is stale. It is a
   * button so the user can read the outcome first.
   */
  protected reloadAfterRestore(): void {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  }

  /** Fetches the suggested backup location and collection size. Failures leave the boxes empty. */
  private loadBackupSuggestion(): void {
    void firstValueFrom(this.api.getBackupSuggestion())
      .then((suggestion) => {
        // Only prefill boxes the user has not already typed into.
        if (this.backupDirectory().length === 0) this.backupDirectory.set(suggestion.directory);
        if (this.backupFileName().length === 0) this.backupFileName.set(suggestion.fileName);
        if (this.restoreFolder.folder().length === 0) {
          this.restoreFolder.folder.set(suggestion.directory);
        }
        this.databaseSizeLabel.set(
          suggestion.databaseSizeBytes === null ? null : formatBytes(suggestion.databaseSizeBytes)
        );
      })
      .catch(() => {
        // Ignored: the boxes stay empty and the panel's hint explains what to type.
      });
  }
}
