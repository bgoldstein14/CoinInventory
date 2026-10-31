/* ===========================================================================
 * image-downscaler.ts
 * ---------------------------------------------------------------------------
 * Shrinks a photo IN THE BROWSER before it is stored, using only a <canvas>.
 * No new dependencies, and the user's original file on the share is never
 * touched - we read it, draw a smaller copy, and throw the big one away.
 *
 * ---------------------------------------------------------------------------
 * WHY (the numbers that drove this decision)
 * ---------------------------------------------------------------------------
 * The share holds 4.2 GB of JPEGs: ~2.5 MB average, largest 46 MB. Images are
 * stored in SQL Server as base64 TEXT, and base64 inflates bytes by 4/3
 * (every 3 bytes become 4 characters). So attaching them untouched would mean:
 *
 *     4.2 GB  x  4/3  =  ~5.6 GB of text in the database
 *
 * ...for pictures that are displayed in a gallery a few hundred pixels wide.
 *
 * ---------------------------------------------------------------------------
 * THE MATHS
 * ---------------------------------------------------------------------------
 * We cap the LONG edge at 1600 px and keep the aspect ratio:
 *
 *     scale = MAX_LONG_EDGE / max(width, height)
 *
 * and only ever apply it when scale < 1 (never upscale - enlarging a small
 * photo adds no detail, just bytes and blur).
 *
 *     4000 x 3000  ->  scale = 1600/4000 = 0.4   ->  1600 x 1200
 *     3000 x 4000  ->  scale = 1600/4000 = 0.4   ->  1200 x 1600
 *     1200 x 900   ->  scale = 1600/1200 = 1.33  ->  left alone at 1200 x 900
 *
 * Re-encoded at JPEG quality 0.85 a 1600 px long edge lands around 250 KB, so
 * base64 stores ~333 KB per photo. For ~1,700 photos that is roughly 0.5 GB
 * instead of 5.6 GB - an order of magnitude smaller, at a resolution that
 * still looks sharp full-screen on a 1080p monitor.
 *
 * Quality 0.85 is the usual sweet spot for photographs: visually
 * indistinguishable from 1.0 for most eyes, but roughly a third of the bytes.
 * Below ~0.75 JPEG blocking starts showing up in the flat fields of a coin,
 * which is exactly where a collector looks for surface detail.
 * =========================================================================== */

import { Injectable } from '@angular/core';

/** Longest edge, in pixels, that we will store. */
export const MAX_LONG_EDGE = 1600;

/** JPEG quality for the re-encode: 0.85 keeps the detail, drops the bytes. */
export const JPEG_QUALITY = 0.85;

/** Result of one downscale: the data URL plus the numbers behind it. */
export interface DownscaleResult {
  /** "data:image/jpeg;base64,..." ready to store in imagePaths. */
  dataUrl: string;
  /** Pixel size we actually produced. */
  width: number;
  height: number;
  /** Bytes of the original file. */
  originalBytes: number;
  /** Approximate bytes of the stored string (base64 characters). */
  storedBytes: number;
  /** False when the image was already small enough to pass through as-is. */
  resized: boolean;
}

/**
 * Pure aspect-ratio maths, split out from anything DOM so it can be unit
 * tested in Node (and read without wading through canvas plumbing).
 *
 * @param width    source width in pixels
 * @param height   source height in pixels
 * @param maxEdge  cap for the longer of the two edges
 * @returns the target size, and whether any scaling was needed at all
 */
export function computeScaledSize(
  width: number,
  height: number,
  maxEdge: number = MAX_LONG_EDGE
): { width: number; height: number; resized: boolean } {
  // Defensive: a failed decode can hand us 0 or NaN. Returning 0x0 would make
  // canvas.toDataURL() throw, so bail out with a 1x1 and let the caller record
  // it as a failure instead of crashing the whole batch.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1, resized: false };
  }

  const longEdge = Math.max(width, height);

  // Already within budget: pass it through untouched. This is the "leaves
  // already-small images alone" rule - no upscaling, ever.
  if (longEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height), resized: false };
  }

  const scale = maxEdge / longEdge;
  return {
    // Math.max(1, ...) guards the extreme panorama case where the short edge
    // would round down to zero pixels.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true
  };
}

/**
 * Rough byte count of a data URL's payload.
 *
 * base64 encodes 3 bytes as 4 characters, so decoded length is
 * characters * 3/4, minus one byte per '=' pad character.
 */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/**
 * Reads an image File and returns a downscaled JPEG data URL.
 *
 * Kept as an injectable service (rather than a bare function) so the batch
 * importer can be handed a stub in tests - there is no <canvas> in the Node
 * test environment.
 */
@Injectable({ providedIn: 'root' })
export class ImageDownscaleService {
  /**
   * Shrink one file.
   *
   * @throws when the file cannot be decoded (corrupt JPEG, or an extension
   *         that slipped past the filter). The caller is expected to catch
   *         this per-file so one bad photo cannot abort a 1,700-file run.
   */
  async downscale(file: File, maxEdge: number = MAX_LONG_EDGE): Promise<DownscaleResult> {
    const bitmap = await this.decode(file);

    try {
      const target = computeScaledSize(bitmap.width, bitmap.height, maxEdge);

      const canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not get a 2D canvas context');

      // A white backdrop matters for PNGs and GIFs with transparency: JPEG has
      // no alpha channel, so without this the transparent areas come out black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, target.width, target.height);

      // The browser's built-in smoothing is a good bilinear/box filter; asking
      // for 'high' avoids the aliasing you get from a raw nearest-neighbour
      // squeeze of a 4000 px photo down to 1600 px.
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, target.width, target.height);

      // Always JPEG, even when the source was a PNG: a photograph of a coin
      // compresses far better as JPEG, and we are not preserving transparency.
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);

      // Free the canvas backing store promptly. Doing 1,700 of these without
      // shrinking the canvas leaves a lot of retained pixel buffers around.
      canvas.width = 0;
      canvas.height = 0;

      return {
        dataUrl,
        width: target.width,
        height: target.height,
        originalBytes: file.size,
        storedBytes: dataUrlByteLength(dataUrl),
        resized: target.resized
      };
    } finally {
      // createImageBitmap results hold native memory until closed. Skipped
      // harmlessly for the HTMLImageElement fallback path.
      const closable = bitmap as unknown as { close?: () => void };
      if (typeof closable.close === 'function') closable.close();
    }
  }

  /**
   * Decode a File into something drawable.
   *
   * Preferred path is createImageBitmap(), which decodes OFF the main thread -
   * that is what keeps the UI from locking up while we chew through a queue of
   * multi-megabyte photos. Older engines get the classic object-URL + <img>
   * fallback, which decodes on the main thread but still works.
   */
  private async decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file);
    }

    return new Promise<HTMLImageElement>((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url); // Must revoke or every photo leaks a blob.
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Could not decode ${file.name}`));
      };
      img.src = url;
    });
  }
}
