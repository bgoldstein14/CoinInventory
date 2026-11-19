 /*
 * image-file-filter.ts
 *
 * Step 1 of the batch image import: drop everything a browser can't draw
 * (RAW .dng/.CR2, .psd, .tif, Thumbs.db, ...) before any matching or
 * decoding, so they never reach the review screen and fail late.
 *
 * Uses an extension allow-list rather than File.type, which on Windows comes
 * from the registry (.dng may report "image/x-adobe-dng", .webp may report "").
 * Every rejection carries a reason, tallied for the summary line.
  */

import {
  ImageFileFilterResult,
  SkipCategory,
  SkipReasonTally,
  SkippedImageFile
} from '../../types/coin.model';

/**
 * Extensions a browser reliably renders in an <img> and re-encodes through a
 * <canvas>.
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
  // Strip any directory part, so a relative path works too.
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

/** Why a single file was rejected, or null when it is acceptable. */
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
 * Split a picker selection into matchable images and skipped files with
 * reasons. Only looks at `file.name`; no file is opened.
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
