/**
 * Types for a coin image plus the path of its original file.
 *
 * `CoinRecord.imagePaths` remains `string[]` of `data:` URLs; source paths are
 * tracked separately in services/image-source-paths.ts and merged into the
 * outgoing request by the editor.
 */

/**
 * One image as `GET /api/coins/:id/images` returns it. `sourcePath` is null
 * whenever the server has no path on record.
 */
export interface CoinImageRecord {
  /**
   * Database id, for DELETE /api/coins/:id/images/:imageId.
   *
   * Not stable across a coin save: a PUT with `imagePaths` deletes and
   * re-inserts all CoinImages rows (IDENTITY column), so re-read the images
   * right before issuing a DELETE.
   */
  imageId: number;
  /** The downscaled `data:` URL that gets displayed. */
  imageData: string;
  /** Absolute path of the ORIGINAL file on the host machine, or null. */
  sourcePath: string | null;
  /** Display order, ascending. */
  sortOrder: number;
}

/**
 * One image sent to the server (`POST /api/coins/:id/images`, or an
 * `imagePaths` entry on coin POST/PUT). A bare base64 string is also accepted
 * and equals a null `sourcePath`.
 */
export interface AttachedImage {
  imageData: string;
  sourcePath: string | null;
}

/**
 * Whether the original file still exists at its recorded path.
 *
 *   'present'  file is readable          -> offer the link
 *   'missing'  file is not there         -> muted, no link
 *   'unknown'  could not check (backend unreachable or not yet checked) -> plain text
 */
export type ImageFileExistence = 'present' | 'missing' | 'unknown';
