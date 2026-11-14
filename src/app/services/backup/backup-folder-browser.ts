/**
 * services/backup/backup-folder-browser.ts — one folder box, with a
 * picker that can only narrow the guess and a server that can settle it.
 *
 * TWO INSTANCES, ONE SHAPE. The backup panel and the restore panel both
 * need "which folder?", and they need it for opposite reasons — one is
 * about to write a file there, the other is about to read one out of it
 * and replace the whole collection with it. The question is the same, so
 * the machinery is, and the Settings dialog owns two of these.
 *
 * WHAT EACH PIECE IS FOR
 *
 *   folder          what will actually be used. Typed, pasted, prefilled
 *                   by the server, or produced by the picker's guess —
 *                   all four end up in the same signal, and a user with
 *                   a UNC path to a NAS the picker cannot reach is never
 *                   blocked by the picker existing.
 *   pickedName      the ONLY thing a browser's directory picker gives us
 *                   (see picked-folder.ts). Kept so the guess note can
 *                   name it.
 *   guessNote       the honest sentence about the gap between the two.
 *   listing         the server's answer: the *.db files really in there.
 *                   This is the live example the image import has — it
 *                   is what makes a wrong guess visible before damage.
 *   error           "there is no folder called D:\Backpus", verbatim from
 *                   the server, which is how a typo gets found.
 *
 * WHY A PLAIN CLASS WITH SIGNALS, like BaseFolderState in the image
 * import and unlike BackupRunner next door: it is UI state and nothing
 * else, Angular signals work perfectly well under Node with no jsdom, and
 * the alternative was ten more fields on a dialog that already has
 * plenty.
 *
 * NOTHING HERE DECIDES ANYTHING. It cannot start a backup and it cannot
 * restore. The worst a bug in this file can do is show the wrong list.
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

  /** Did the last pick hand us any files at all? Drives the empty-folder note. */
  private readonly pickHadFiles = signal(false);

  /** True once a pick has happened, so the note is not shown before one. */
  private readonly picked = signal(false);

  /** The server's list, or null before anything has been asked. */
  readonly listing = signal<BackupDirectoryListing | null>(null);

  /** The server's refusal, verbatim. Null when there is nothing wrong. */
  readonly error = signal<string | null>(null);

  /** True while the listing request is in flight. */
  readonly busy = signal(false);

  /**
   * The disclosure about the picker's guess, or null when none is needed.
   *
   * *** DO NOT SUPPRESS THIS ONCE THE LISTING SUCCEEDS. *** A successful
   * listing proves the folder exists; it does not prove it is the folder
   * the user picked. `C:\Users\You\Desktop\Backups` and `D:\Backups` can
   * both exist and only one of them is theirs.
   */
  readonly guessNote = computed(() =>
    this.picked()
      ? describeFolderGuess(this.pickedName(), this.folder(), this.pickHadFiles())
      : null
  );

  /**
   * @param list  asks the server for the `*.db` files in a folder. A
   *              function rather than ApiService, so this class can be
   *              tested without Angular's HTTP stack — the same contract
   *              BackupRunner uses.
   */
  constructor(private readonly list: (directory: string) => Promise<BackupDirectoryListing>) {}

  /**
   * The user typed, pasted, or had a value prefilled.
   *
   * Every previous answer is thrown away. A list of files sitting under a
   * path that has since been edited is the same trap a stale inspection
   * verdict is: it describes a folder that is no longer the one named.
   */
  setFolder(value: string): void {
    this.folder.set(value);
    this.listing.set(null);
    this.error.set(null);
    this.picked.set(false);
    this.pickedName.set(null);
  }

  /**
   * The directory picker came back.
   *
   * The guess goes straight into the box rather than being offered for
   * confirmation, because the box is still fully editable and the note
   * underneath says what was assumed. An extra "apply?" step would make
   * the common case — the guess is right — slower for no gain.
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
   * Ask the server what is really in there.
   *
   * *** THIS IS THE PART THAT MAKES THE PICKER SAFE. *** Everything above
   * is a guess; this is the disk. A wrong guess comes back as a refusal
   * naming the folder, or as a folder with no backups in it, and either
   * one is visible before a byte is written or replaced.
   *
   * Refuses to run on an empty box rather than asking the server to have
   * an opinion about ''.
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
      // `messageFrom` from the runner, deliberately: the server's own
      // sentence ("There is no folder called D:\Backpus") is the thing
      // that finds a typo, and one unwrapper for all of §16's HTTP
      // failures is one place for it to stay right.
      this.error.set(messageFrom(err));
    } finally {
      this.busy.set(false);
    }
  }
}
