/**
 * coin-image.model.ts — the types for "an image, plus where the original file
 * lives".
 *
 * WHY A SEPARATE FILE FROM coin.model.ts
 * `coin.model.ts` is already long, and these three types are only interesting
 * to the image feature: the import that records a path, the API that carries
 * one, and the viewer that renders one. Keeping them together here means the
 * whole original-file-path story is readable in one short file.
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON `CoinRecord.imagePaths`, WHICH IS *NOT* CHANGED BY THIS FEATURE
 * ---------------------------------------------------------------------------
 * `CoinRecord.imagePaths` stays `string[]` — an array of downscaled `data:`
 * URLs, which is what every `<img [src]>` in the app binds to. It is
 * deliberately NOT widened to hold objects: the gallery, the photo viewer, the
 * table thumbnail and the change tracker all treat those entries as strings,
 * and changing that would be a large, risky edit for no display benefit.
 *
 * Instead the source paths ride alongside, in ImageSourcePathRegistry, and are
 * stitched back onto the outgoing request by the editor. See
 * services/image-source-paths.ts for that mechanism and why it is shaped that
 * way.
 */

/**
 * One image as `GET /api/coins/:id/images` returns it.
 *
 * `sourcePath` is null whenever the server has no path on record — an image
 * imported before this feature existed, an image pasted in from the gallery's
 * own file picker, or a database where migration 002 has not been run yet (the
 * server normalises that case to null too, so the client has exactly ONE
 * "unknown" to handle rather than three).
 */
export interface CoinImageRecord {
  /** Database id, needed by DELETE /api/coins/:id/images/:imageId. */
  imageId: number;
  /** The downscaled `data:` URL that gets displayed. */
  imageData: string;
  /** Absolute path of the ORIGINAL file on the host machine, or null. */
  sourcePath: string | null;
  /** Display order, ascending. */
  sortOrder: number;
}

/**
 * One image on its way TO the server, in the object form that
 * `POST /api/coins/:id/images` and the `imagePaths` array on
 * `POST /api/coins` / `PUT /api/coins/:id` accept.
 *
 * The server also still accepts a bare base64 string for backwards
 * compatibility (see server/routes/coins/image-payload.ts), which is what a
 * `sourcePath` of null is equivalent to.
 */
export interface AttachedImage {
  imageData: string;
  sourcePath: string | null;
}

/**
 * Does the original file still exist where we recorded it?
 *
 * THREE states, not two, and the third one matters:
 *
 *   'present'  the backend looked and the file is readable  -> offer the link
 *   'missing'  the backend looked and it is not there       -> muted, no link
 *   'unknown'  we could not ask (backend unreachable, check
 *              not run yet)                                 -> plain text
 *
 * Collapsing 'unknown' into 'missing' would tell the user his photo library
 * had evaporated every time the server was restarting, so the viewer renders
 * an unknown path as plain, un-muted text and makes no claim either way.
 */
export type ImageFileExistence = 'present' | 'missing' | 'unknown';
