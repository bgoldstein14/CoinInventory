/*
 * referenced-encoder.ts — the encoder for referenced storage, which never
 * opens the file: it returns a reference URL to the original instead of a
 * downscaled picture. Plugged into `runAttach` as `encode`, so skip rules,
 * error isolation and progress work the same in both modes.
 *
 * A referenced photo is its path, so with no base folder (no path can be
 * built; see source-path.ts) the file is reported as a per-file failure
 * rather than silently dropped. The import screen also refuses such a run up
 * front; this guard covers callers that bypass it.
 */

import type { EncodedImage } from './attach-runner';
import { referenceUrlForPath } from './reference-url';
import { sourcePathForFile } from './source-path';

/** What the user is told when a referenced import has nowhere to point. */
export const NO_BASE_FOLDER_MESSAGE =
  'Referenced storage records where the photo lives, and no folder was confirmed for ' +
  'these files — so there would be nothing to record. Set the photo folder on this ' +
  'screen, or switch Settings to keep photos in the database.';

/**
 * Build the referenced-mode encoder.
 *
 * @param baseFolder the folder the picked photos live in on the host machine
 * @param urlFor     turns a path into something an `<img>` can load. Defaults
 *                   to the relative route; the import screen passes
 *                   `ApiService.imageFileUrl` for an absolute URL (needed
 *                   under `ng serve`). See reference-url.ts.
 */
export function makeReferencedEncoder(
  baseFolder: string | undefined,
  urlFor: (sourcePath: string) => string = referenceUrlForPath
): (file: File) => Promise<EncodedImage> {
  return async (file: File): Promise<EncodedImage> => {
    const trimmed = baseFolder?.trim();
    const sourcePath = trimmed ? sourcePathForFile(trimmed, file) : null;

    if (!sourcePath) throw new Error(NO_BASE_FOLDER_MESSAGE);

    return {
      dataUrl: urlFor(sourcePath),
      originalBytes: file.size,
      // Nothing is stored in the database in this mode.
      storedBytes: 0
    };
  };
}
