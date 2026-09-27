import { signal } from '@angular/core';

/**
 * ThumbnailCache — holds the selected File handles and creates preview URLs
 * for them ON DEMAND.
 *
 * WHY THIS EXISTS (it is a performance rule, not a convenience)
 * ------------------------------------------------------------
 * `URL.createObjectURL(file)` is cheap by itself, but the moment that URL goes
 * into an `<img src>` the browser reads and decodes the whole file. Selecting
 * the share's root gives us ~1,700 displayable photos averaging 2.5 MB, so
 * eagerly previewing all of them means gigabytes of decoded pixel data and a
 * dead tab.
 *
 * So the rule is: a preview URL exists only for a coin group the user has
 * actually opened. The import flow never needs a preview to do its job -
 * matching is done on filenames - which makes previews purely opt-in.
 *
 * The cache also owns REVOKING the URLs. An object URL keeps its file alive
 * for the lifetime of the document, so forgetting to revoke 1,700 of them is a
 * multi-gigabyte leak that survives closing the modal.
 */
export class ThumbnailCache {
  /** File handles from the picker, keyed by filename. */
  readonly files = new Map<string, File>();

  /** filename -> blob URL, for the previews that have been created so far. */
  private readonly created = signal<Record<string, string>>({});

  /** Reactive view of the created URLs, for templates. */
  readonly urls = this.created.asReadonly();

  /** Remember the File handles from a picker selection. Creates no URLs. */
  register(files: readonly File[]): void {
    for (const file of files) this.files.set(file.name, file);
  }

  /**
   * Make sure a preview URL exists for each of these filenames.
   * Already-created URLs are left as they are, so re-opening a group is free.
   */
  create(fileNames: readonly string[]): void {
    // Guarded because there is no createObjectURL in the Node test environment.
    if (typeof URL === 'undefined' || !URL.createObjectURL) return;

    const next = { ...this.created() };
    let added = false;
    for (const fileName of fileNames) {
      if (next[fileName]) continue;
      const file = this.files.get(fileName);
      if (!file) continue;
      next[fileName] = URL.createObjectURL(file);
      added = true;
    }
    // Only touch the signal when something actually changed, so expanding an
    // already-loaded group does not trigger a pointless re-render.
    if (added) this.created.set(next);
  }

  /** Revoke every URL and forget every file handle. */
  clear(): void {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      for (const url of Object.values(this.created())) URL.revokeObjectURL(url);
    }
    this.created.set({});
    this.files.clear();
  }
}
