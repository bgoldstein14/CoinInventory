/*
 * image-thumbnail.ts — shrink a stored photograph down to printing size.
 *
 * WHY SHRINK AT ALL, WHEN imagePaths IS ALREADY "DOWNSCALED"? Those copies
 * were downscaled once for a full-screen viewer — roughly 1600px, about
 * 250 KB of base64 each — which is the right size for filling a monitor and
 * wildly the wrong size for a picture printed at about one inch. A tenth of
 * the bytes is the difference between a report that prints and a browser
 * that stops responding; see the arithmetic in report-images.ts. Nothing
 * visible is lost: at 1.05in on the page, 480px is roughly 430 dpi, past
 * what any home printer resolves.
 *
 * WHY THE SIZE MATHS IS A SEPARATE, EXPORTED FUNCTION. Everything below
 * `thumbnailSize` needs an `Image`, a `<canvas>` and `toDataURL`, none of
 * which exist in Node, where this project's tests run. So the canvas work is
 * kept to the smallest possible block and the decision it depends on — how
 * big, and the three ways that goes wrong — is a pure function with a spec.
 */

import { THUMBNAIL_MAX_EDGE_PX } from './report-images';

export interface ThumbnailSize {
  width: number;
  height: number;
}

/**
 * Fit an image inside a square of `maxEdge`, preserving its aspect ratio.
 *
 * Three guards, each for a real failure:
 *
 *   NEVER ENLARGE. A 200px photograph scaled up to 480 is a bigger file and
 *   no more detail. `Math.min(1, ...)` keeps the scale at or below 1.
 *
 *   NEVER ROUND TO ZERO. `canvas.width = 0` throws, and a freak aspect ratio
 *   (a 2000x1 strip from a corrupt record) would otherwise produce exactly
 *   that. One unreadable image must not take the report down.
 *
 *   NO DIMENSIONS AT ALL. A decode failure reports 0x0. Falling back to a
 *   square at the cap means the draw either works or fails on its own terms,
 *   rather than dividing by zero here.
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

/**
 * JPEG quality for the embedded thumbnail.
 *
 * 0.72 rather than the browser default of 0.92. At the printed size the
 * difference is invisible and it is worth roughly half the bytes; JPEG rather
 * than PNG because these are photographs, where PNG would be several times
 * larger for no gain.
 */
const THUMBNAIL_JPEG_QUALITY = 0.72;

/**
 * Re-encode one stored `data:` URL as a small JPEG `data:` URL.
 *
 * Rejects rather than returning the original on failure. The caller
 * (collectReportImages) counts a rejection and names it on the document;
 * silently substituting the 250 KB original would defeat the point of this
 * module, invisibly, a few hundred times over.
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

    // These are `data:` URLs the app stored itself, so there is no network
    // fetch and no cross-origin taint — `toDataURL` on the canvas would throw
    // a SecurityError if there were.
    image.src = dataUrl;
  });
}
