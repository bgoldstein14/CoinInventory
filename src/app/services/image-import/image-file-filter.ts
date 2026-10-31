/* ===========================================================================
 * image-file-filter.ts
 * ---------------------------------------------------------------------------
 * STEP 1 of the batch image import: throw away everything a browser cannot
 * draw, BEFORE we do any matching, reading or decoding.
 *
 * Why this has to be first
 * ------------------------
 * Pointing the picker at the photo share hands us ~2,140 files across 8
 * subfolders. A big chunk of them are not web images at all:
 *
 *   .dng   343 files   RAW from the camera. An <img> tag renders nothing.
 *   .CR2    40 files   Canon RAW. Same story.
 *   .psd    11 files   Photoshop layered document.
 *   .tif     2 files   Not supported by Chrome/Edge.
 *   plus Thumbs.db, desktop.ini and stray .info text files.
 *
 * If those reached the review screen the user would tick them, we would try to
 * decode them, and they would silently fail at the very end of a long run.
 * Filtering here means the review screen only ever shows files we can actually
 * display and save.
 *
 * Why we do NOT trust File.type
 * -----------------------------
 * The old code used `file.type.startsWith('image/')`. On Windows that is
 * whatever the registry says: .dng often reports "image/x-adobe-dng" (passes
 * the test, still undecodable) and .webp sometimes reports "" (fails the test,
 * perfectly displayable). The extension is the only thing we can reason about
 * consistently, so we use an explicit allow-list of extensions and treat
 * File.type as a hint only.
 *
 * Nothing is dropped silently: every rejection is returned with a reason, and
 * the reasons are tallied for the summary line.
 * =========================================================================== */

import {
  ImageFileFilterResult,
  SkipCategory,
  SkipReasonTally,
  SkippedImageFile
} from '../../types/coin.model';

/**
 * The only extensions a browser will reliably render in an <img> AND re-encode
 * through a <canvas>. Deliberately conservative - if it is not on this list we
 * do not offer it.
 */
export const DISPLAYABLE_IMAGE_EXTENSIONS = [
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'
] as const;

/** RAW formats: camera sensor data, needs a converter, not an <img>. */
const RAW_EXTENSIONS = ['dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf', 'srw', 'pef'];

/** Layered / print formats browsers refuse to decode. */
const LAYERED_EXTENSIONS = ['psd', 'psb', 'tif', 'tiff', 'heic', 'heif', 'svgz', 'jp2', 'eps'];

/**
 * Operating-system clutter that shows up in every folder on a Windows share.
 * Matched on the whole filename (lower-cased), not the extension.
 */
const SYSTEM_FILENAMES = ['thumbs.db', 'desktop.ini', '.ds_store', 'ehthumbs.db', 'picasa.ini'];

/**
 * Lower-case extension without the dot, or '' when the name has none.
 * "1881-S $1 - Obverse.JPG" -> "jpg";  "notes" -> "".
 */
export function fileExtension(fileName: string): string {
  // Strip any directory part first. webkitdirectory gives us `webkitRelativePath`
  // on the File, but `name` is already bare - this just makes the helper safe
  // to call with a full relative path too.
  const bare = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = bare.lastIndexOf('.');
  // dot <= 0 covers both "no extension" and dotfiles like ".info".
  if (dot <= 0) return '';
  return bare.slice(dot + 1).toLowerCase();
}

/** True when this file is something we can show and re-encode. */
export function isDisplayableImage(fileName: string): boolean {
  const name = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
  if (SYSTEM_FILENAMES.includes(name)) return false;
  return (DISPLAYABLE_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(fileName));
}

/**
 * Decide why a single file was rejected. Returns null when it is acceptable.
 * Split out from the loop so the reason text lives in exactly one place.
 */
function classifyRejection(fileName: string): { category: SkipCategory; reason: string } | null {
  const name = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
  const ext = fileExtension(fileName);

  if (SYSTEM_FILENAMES.includes(name)) {
    return { category: 'system-file', reason: 'Operating-system file, not a photo' };
  }
  if ((DISPLAYABLE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return null; // Good - keep it.
  }
  if (RAW_EXTENSIONS.includes(ext)) {
    return {
      category: 'raw-photo',
      reason: `RAW camera file (.${ext}) - a browser cannot display it`
    };
  }
  if (LAYERED_EXTENSIONS.includes(ext)) {
    return {
      category: 'layered-image',
      reason: `Not web-displayable (.${ext}) - convert it to JPEG first`
    };
  }
  return {
    category: 'not-an-image',
    reason: ext ? `Not an image file (.${ext})` : 'No file extension - not an image'
  };
}

/**
 * Split a raw picker selection into "matchable images" and "skipped, here is why".
 *
 * Cheap on purpose: it only looks at `file.name`. No file is opened, so this
 * stays instant even for the full 4.2 GB share.
 */
export function filterImageFiles(files: readonly File[]): ImageFileFilterResult {
  const accepted: File[] = [];
  const skipped: SkippedImageFile[] = [];

  for (const file of files) {
    const rejection = classifyRejection(file.name);
    if (rejection) {
      skipped.push({ fileName: file.name, ...rejection });
    } else {
      accepted.push(file);
    }
  }

  return {
    accepted,
    skipped,
    tallies: tallySkipReasons(skipped),
    totalSelected: files.length
  };
}

/**
 * Collapse the rejection list to one line per reason, biggest group first.
 * "343 RAW camera files (.dng)" reads far better than 343 rows.
 */
export function tallySkipReasons(skipped: readonly SkippedImageFile[]): SkipReasonTally[] {
  const byReason = new Map<string, SkipReasonTally>();

  for (const entry of skipped) {
    const existing = byReason.get(entry.reason);
    if (existing) {
      existing.count += 1;
    } else {
      byReason.set(entry.reason, {
        category: entry.category,
        reason: entry.reason,
        count: 1
      });
    }
  }

  return [...byReason.values()].sort((a, b) => b.count - a.count);
}
