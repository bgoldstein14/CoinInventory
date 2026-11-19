import { signal } from '@angular/core';

/**
 * ThumbnailCache — holds the selected File handles and creates preview URLs
 * on demand.
 *
 * Putting an object URL in an `<img src>` makes the browser decode the whole
 * file, so previewing every photo in a large folder would exhaust memory.
 * Preview URLs are only created for coin groups the user opens (matching uses
 * filenames, not pixels). The cache also revokes them, since an object URL
 * keeps its file alive for the life of the document.
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
    // No createObjectURL in the Node test environment.
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
    // Only update the signal when something changed, to avoid a re-render.
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
