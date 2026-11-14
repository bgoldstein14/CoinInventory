/*
 * referenced-encoder.ts — the "encoder" for referenced storage, which is the
 * one that reads nothing.
 *
 * `runAttach` calls `options.encode(file)` for every photo it is going to
 * attach, and in the stored mode that is a full read + JPEG decode + canvas
 * downscale of a file that can be 46 MB, pulled over an SMB share. In the
 * referenced mode there is nothing to encode: the database is going to hold
 * the path and not the picture, so the file is never opened at all. An
 * import of 300 photos becomes 300 string operations.
 *
 * It still goes through `encode` rather than being a branch inside the runner
 * because that keeps ONE write path: the runner's skip rules, per-file error
 * isolation, progress counting and per-coin grouping all stay exactly as they
 * are, and the only thing that differs between the two modes is what one
 * photo turns into.
 *
 * *** WHY A MISSING PATH IS A FAILURE AND NOT A SILENT FALLBACK ***
 *
 * A referenced photo IS its path. With no base folder confirmed, the browser
 * cannot tell us where a picked file actually lives (see source-path.ts), so
 * there is no path to record — and a row with neither a picture nor a path
 * is a photo that has been thrown away. The file is therefore reported as a
 * failure, by name, with a sentence saying what to do about it. The runner
 * catches it per file, so the rest of the run is unaffected and the summary
 * names every photo that did not make it.
 *
 * (The import screen refuses the whole run up front for the same reason, so
 * in practice this guard fires only if that one is ever bypassed. It stays
 * because "nothing was silently discarded" must be true of the engine, not
 * only of the screen in front of it.)
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
 * @param urlFor     how to turn a path into something an `<img>` can load.
 *                   Defaults to the relative route; the import screen passes
 *                   `ApiService.imageFileUrl` so the URL is absolute, which
 *                   matters under `ng serve`, where the page (:4200) and the
 *                   API (:3000) are on different origins. Either form is
 *                   recognised as a reference on the way back in — see
 *                   reference-url.ts.
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
      // Nothing goes into the database, so nothing is added to its size. This
      // is what makes the import summary's "stored" figure honest: in this
      // mode it is zero, and it should read as zero.
      storedBytes: 0
    };
  };
}
