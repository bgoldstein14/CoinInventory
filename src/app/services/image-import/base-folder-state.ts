/* ===========================================================================
 * BaseFolderState — the one piece of information the browser cannot give us.
 * ---------------------------------------------------------------------------
 * Browsers never reveal where a file really lives on disk. A directory picker
 * hands us only `File.webkitRelativePath` — the path RELATIVE to the folder the
 * user chose ("Business Strikes/1865 3CN - Obverse.jpg"). To store an absolute
 * path in `CoinImages.SourcePath` we have to know what that folder was, and the
 * user is the only one who does. So they confirm it once and it is remembered.
 *
 * See source-path.ts for the joining rules and the full explanation, and
 * import-base-folder.ts for the persistence.
 *
 * WHY ITS OWN CLASS rather than three more fields on BatchImportSession: the
 * session is already the biggest file in the feature, and this is a
 * self-contained little unit — one value, one preview derived from it, one
 * save, one load. Keeping it here means the session file stays about the import
 * flow.
 * =========================================================================== */

import { Signal, computed, signal } from '@angular/core';
import { StorageService } from '../storage.service';
import { previewSourcePath } from './source-path';
import { loadImportBaseFolder, saveImportBaseFolder } from './import-base-folder';

export class BaseFolderState {
  /**
   * Where the photos live on the machine HOSTING the app.
   *
   * Starts EMPTY and is filled in by `restore()` a moment later, because both
   * of the places a starting value can come from are asynchronous: the saved
   * preference is in IndexedDB and the app-folder fallback is an HTTP call. An
   * empty box for those few milliseconds is the honest rendering — nothing can
   * be imported in that window, so there is nothing to race with.
   */
  readonly value = signal<string>('');

  /** True when there is no folder, so nothing sensible can be recorded. */
  readonly missing = computed(() => this.value().trim().length === 0);

  /**
   * A live, finished example of what will be stored, built from the first
   * selected file.
   *
   * THIS IS THE GUARD RAIL FOR THE WHOLE FEATURE. A wrong base folder is
   * invisible on its own but obvious the moment you see the path it produces,
   * and showing it before anything is written is what stops the user stamping
   * 1,700 rows with a location nothing can open.
   */
  readonly preview: Signal<string | null>;

  /**
   * @param firstFile  the first accepted file of the current selection, or
   *                   undefined before anything is picked. A signal, so the
   *                   example refreshes when a different folder is selected.
   * @param storage    where the value is remembered. Optional: without it the
   *                   folder simply resets each time.
   *
   * There used to be a third parameter, an `AppFolderProvider` that seeded a
   * fresh install with the app's own install directory. It was removed because
   * that seed is never the right answer and, being a plausible-looking path,
   * was worse than an empty box — see the header of import-base-folder.ts.
   */
  constructor(
    firstFile: Signal<File | undefined>,
    private readonly storage?: StorageService
  ) {
    this.preview = computed(() => previewSourcePath(this.value(), firstFile()));
  }

  /**
   * Work out the starting value: the remembered folder if there is one,
   * otherwise empty.
   *
   * The decision lives in `loadImportBaseFolder` (see import-base-folder.ts)
   * rather than here, so there is exactly one place that makes it.
   *
   * `value` already starts at `''`, so with no storage there is nothing to do
   * and nothing to await.
   */
  async restore(): Promise<void> {
    if (!this.storage) return;
    this.value.set(await loadImportBaseFolder(this.storage));
  }

  /**
   * The user edited the box. Saved immediately rather than on confirm, so the
   * value survives an abandoned import.
   *
   * The promise is returned rather than swallowed so a test can await the
   * write. The template ignores it, which is the fire-and-forget behaviour the
   * UI wants — typing must never wait on IndexedDB.
   */
  set(next: string): Promise<void> {
    this.value.set(next);
    return this.storage ? saveImportBaseFolder(this.storage, next) : Promise.resolve();
  }
}
