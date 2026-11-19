 /*
 * BaseFolderState — the absolute folder the picked photos live in.
 *
 * A directory picker only gives paths relative to the chosen folder, so the
 * user supplies the absolute folder once and it is remembered. See
 * source-path.ts for joining rules and import-base-folder.ts for persistence.
  */

import { Signal, computed, signal } from '@angular/core';
import { StorageService } from '../storage.service';
import { previewSourcePath } from './source-path';
import { loadImportBaseFolder, saveImportBaseFolder } from './import-base-folder';

export class BaseFolderState {
  /**
   * Where the photos live on the machine hosting the app. Starts empty until
   * `restore()` reads the saved value (or the default folder).
   */
  readonly value = signal<string>('');

  /** True when there is no folder, so nothing sensible can be recorded. */
  readonly missing = computed(() => this.value().trim().length === 0);

  /**
   * Example of the path that will be stored, built from the first selected
   * file, so a wrong base folder is visible before importing.
   */
  readonly preview: Signal<string | null>;

  /**
   * @param firstFile  the first accepted file of the current selection, or
   *                   undefined before anything is picked. A signal, so the
   *                   example refreshes when a different folder is selected.
   * @param storage    where the value is remembered. Optional: without it the
   *                   folder resets each time.
   * @param defaultFolder the folder to start with when nothing is remembered
   *                   (the user's Documents folder). Optional.
   */
  constructor(
    firstFile: Signal<File | undefined>,
    private readonly storage?: StorageService,
    private readonly defaultFolder?: () => Promise<string>
  ) {
    this.preview = computed(() => previewSourcePath(this.value(), firstFile()));
  }

  /** Load the remembered folder; with none, start at the default folder. */
  async restore(): Promise<void> {
    const remembered = this.storage ? await loadImportBaseFolder(this.storage) : '';
    if (remembered.trim() || !this.defaultFolder) {
      this.value.set(remembered);
      return;
    }
    // A failed lookup leaves the box empty. Don't overwrite anything typed meanwhile.
    const fallback = await this.defaultFolder().catch(() => '');
    if (!this.value().trim()) this.value.set(fallback);
  }

  /**
   * The user edited the box. Saved immediately so the value survives an
   * abandoned import. The template ignores the promise; tests can await it.
   */
  set(next: string): Promise<void> {
    this.value.set(next);
    return this.storage ? saveImportBaseFolder(this.storage, next) : Promise.resolve();
  }
}
