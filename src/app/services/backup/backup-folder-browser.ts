/**
 * UI state for one backup/restore folder box: the folder to use, the name the
 * directory picker reported, a note explaining the picker's guess, and the
 * server's listing of `*.db` files in the folder. The Settings dialog has two
 * instances (backup and restore). Plain class with signals, testable under Node.
 */

import { computed, signal } from '@angular/core';

import type { BackupDirectoryListing } from './backup-messages';
import { messageFrom } from './backup-runner';
import {
  describeFolderGuess,
  folderNameFromPicker,
  guessFolderPath,
  type PickedFile,
} from './picked-folder';

/** How the browser answers `(change)` on a directory input. */
export type FolderPickResult = readonly PickedFile[];

export class BackupFolderBrowser {
  /** The folder that will actually be used. */
  readonly folder = signal('');

  /** The folder name the picker reported, or null if it never ran. */
  readonly pickedName = signal<string | null>(null);

  /** Whether the last pick returned any files (drives the empty-folder note). */
  private readonly pickHadFiles = signal(false);

  /** True once a pick has happened, so the note isn't shown before one. */
  private readonly picked = signal(false);

  /** The server's list, or null before anything has been asked. */
  readonly listing = signal<BackupDirectoryListing | null>(null);

  /** The server's error message, verbatim; null when fine. */
  readonly error = signal<string | null>(null);

  /** True while the listing request is in flight. */
  readonly busy = signal(false);

  /**
   * Note about the picker's guess, or null. Kept even after a successful
   * listing: an existing folder isn't necessarily the one the user picked.
   */
  readonly guessNote = computed(() =>
    this.picked()
      ? describeFolderGuess(this.pickedName(), this.folder(), this.pickHadFiles())
      : null
  );

  /** @param list asks the server for the `*.db` files in a folder (a function, so tests need no HTTP). */
  constructor(private readonly list: (directory: string) => Promise<BackupDirectoryListing>) {}

  /** Sets the folder from typing, pasting or a prefill, and discards previous answers. */
  setFolder(value: string): void {
    this.folder.set(value);
    this.listing.set(null);
    this.error.set(null);
    this.picked.set(false);
    this.pickedName.set(null);
  }

  /**
   * Applies a directory pick: the guessed path goes straight into the (still
   * editable) box, and the note explains what was assumed.
   */
  acceptPick(files: FolderPickResult | null | undefined): void {
    const name = folderNameFromPicker(files);

    this.listing.set(null);
    this.error.set(null);
    this.picked.set(true);
    this.pickHadFiles.set((files?.length ?? 0) > 0);
    this.pickedName.set(name);

    if (name) this.folder.set(guessFolderPath(this.folder(), name));
  }

  /**
   * Asks the server what is in the folder. This makes a wrong picker guess
   * visible before anything is written or replaced. Does nothing for an empty box.
   */
  async refresh(): Promise<void> {
    const directory = this.folder().trim();
    if (directory.length === 0 || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    this.listing.set(null);

    try {
      this.listing.set(await this.list(directory));
    } catch (err) {
      // The server's message (e.g. "There is no folder called D:\Backpus") helps find typos.
      this.error.set(messageFrom(err));
    } finally {
      this.busy.set(false);
    }
  }
}
