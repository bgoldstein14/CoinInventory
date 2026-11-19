/*
 * image-thumbnail.ts — shrink a stored photograph (about 1600px) to printing
 * size. At about one inch on the page, 480px is still around 430 dpi, and the
 * smaller files keep a large report from stalling the browser.
 *
 * The size calculation is a separate pure function so it can be tested
 * without a canvas.
 */

import { THUMBNAIL_MAX_EDGE_PX } from './report-images';

export interface ThumbnailSize {
  width: number;
  height: number;
}

/**
 * Fit an image inside a square of `maxEdge`, preserving its aspect ratio.
 * Never enlarges, never rounds a side to zero (canvas.width = 0 throws), and
 * falls back to a square at the cap when the image reports no dimensions.
 */
export function thumbnailSize(
  naturalWidth: number,
  naturalHeight: number,
  maxEdge: number = THUMBNAIL_MAX_EDGE_PX
): ThumbnailSize {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { width: maxEdge, height: maxEdge };
  }

  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));

  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale))
  };
}

/** JPEG quality for the thumbnail: invisible at print size, about half the bytes of 0.92. */
const THUMBNAIL_JPEG_QUALITY = 0.72;

/**
 * Re-encode one stored `data:` URL as a small JPEG `data:` URL. Rejects on
 * failure rather than returning the full-size original; the caller counts it.
 */
export function toReportThumbnail(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      try {
        const { width, height } = thumbnailSize(image.naturalWidth, image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('no 2d context'));
          return;
        }

        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', THUMBNAIL_JPEG_QUALITY));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    image.onerror = () => reject(new Error('image failed to decode'));

    // Locally stored data: URLs, so the canvas is never cross-origin tainted.
    image.src = dataUrl;
  });
}
