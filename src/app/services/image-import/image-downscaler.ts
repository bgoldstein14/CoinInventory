 /*
 * image-downscaler.ts
 *
 * Shrinks a photo in the browser with a <canvas> before it is stored. The
 * original file is never modified.
 *
 * Images are stored in SQL Server as base64 text (4/3 the byte size), so
 * originals averaging ~2.5 MB would bloat the database. The long edge is
 * capped at 1600 px, keeping aspect ratio and never upscaling:
 *
 *     4000 x 3000  ->  scale 0.4  ->  1600 x 1200
 *     1200 x 900   ->  left alone
 *
 * At JPEG quality 0.85 that is roughly 250 KB per photo, still sharp
 * full-screen at 1080p. Below ~0.75, JPEG blocking shows in a coin's flat
 * fields.
  */

import { Injectable } from '@angular/core';
import { encodeWithinBudget, type BudgetedEncode } from './encode-budget';

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
 * Target size for a long-edge cap, preserving aspect ratio. Pure, so it can
 * be unit tested in Node.
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
  // A failed decode can report 0 or NaN; 0x0 would make toDataURL() throw,
  // so return 1x1 and let the caller record a per-file failure.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1, resized: false };
  }

  const longEdge = Math.max(width, height);

  // Already small enough: never upscale.
  if (longEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height), resized: false };
  }

  const scale = maxEdge / longEdge;
  return {
    // Math.max(1, ...) stops an extreme panorama's short edge rounding to 0.
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
 * Reads an image File and returns a downscaled JPEG data URL. A service so
 * tests can stub it (no <canvas> in Node).
 */
@Injectable({ providedIn: 'root' })
export class ImageDownscaleService {
  /**
   * Shrink one file.
   *
   * @throws when the file cannot be decoded. Callers catch this per file so
   *         one bad photo doesn't abort the run.
   */
  async downscale(file: File, maxEdge: number = MAX_LONG_EDGE): Promise<DownscaleResult> {
    const bitmap = await this.decode(file);

    try {
      return this.render(bitmap, file, maxEdge, JPEG_QUALITY);
    } finally {
      // ImageBitmaps hold native memory until closed (no-op for <img>).
      const closable = bitmap as unknown as { close?: () => void };
      if (typeof closable.close === 'function') closable.close();
    }
  }

  /**
   * Shrink one file so the stored copy fits a byte budget (see
   * encode-budget.ts). Decoded once and re-drawn per attempt, since decoding
   * is the expensive step.
   */
  async downscaleWithin(file: File, maxStoredBytes: number): Promise<BudgetedEncode> {
    const bitmap = await this.decode(file);

    try {
      return await encodeWithinBudget(maxStoredBytes, attempt =>
        Promise.resolve(this.render(bitmap, file, attempt.maxEdge, attempt.quality))
      );
    } finally {
      const closable = bitmap as unknown as { close?: () => void };
      if (typeof closable.close === 'function') closable.close();
    }
  }

  /** One encode of an already-decoded image at a given size and quality. */
  private render(
    bitmap: ImageBitmap | HTMLImageElement,
    file: File,
    maxEdge: number,
    quality: number
  ): DownscaleResult {
    const target = computeScaledSize(bitmap.width, bitmap.height, maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get a 2D canvas context');

    // White backdrop: JPEG has no alpha, so transparent areas would be black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);

    // 'high' smoothing avoids aliasing on large downscales.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, target.width, target.height);

    // Always JPEG: photos compress far better, and transparency isn't kept.
    const dataUrl = canvas.toDataURL('image/jpeg', quality);

    // Free the canvas backing store promptly; large batches otherwise retain
    // many pixel buffers.
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
  }

  /**
   * Decode a File into something drawable. createImageBitmap() decodes off the
   * main thread, keeping the UI responsive; older engines fall back to <img>.
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
