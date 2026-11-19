/**
 * The coin image sub-resource (CoinImages: one row per image, ordered by
 * SortOrder). Mounted at /api/coins:
 *
 *   GET    /:id/images            full images for one coin
 *   POST   /:id/images            append images
 *   DELETE /:id/images/:imageId   remove one image
 *
 * GET /api/coins omits image payloads, so the detail panel loads them here.
 * POST appends (so needs no SourcePath rescue), while PUT /api/coins/:id with
 * `imagePaths` replaces the whole set. `sourcePath` is the original
 * full-resolution file on the host; ImageData is a downscaled copy. Serving
 * originals is in routes/images/.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS, DbRequest, DbTransaction } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback } from './write-helpers';
import { normalizeImageEntries, type NormalizedImage } from './image-payload';
import { originFromRequest, referenceUrlFor } from '../images/reference-url';

const router = Router();

/**
 * What one row's `imageData` is on the wire:
 *
 *   stored      the base64 data URL as stored
 *   referenced  ImageData NULL, SourcePath set: the URL that streams that file
 *   neither     null
 *
 * Exported for tests.
 */
export function resolveImageData(
  storedImageData: unknown,
  sourcePath: unknown,
  origin: string
): string | null {
  if (typeof storedImageData === 'string' && storedImageData.length > 0) {
    return storedImageData;
  }

  if (typeof sourcePath === 'string' && sourcePath.trim().length > 0) {
    return referenceUrlFor(sourcePath.trim(), origin);
  }

  return null;
}

// GET /api/coins/:id/images — full images for ONE coin, in display order
//
// Response shape (an array, ordered by SortOrder):
//
//   [ { "imageId": 12, "imageData": "data:image/jpeg;base64,...", "sortOrder": 0,
//       "sourcePath": "C:\\Coin Pictures\\1921-morgan-obverse.jpg" },
//     { "imageId": 13, "imageData": "data:image/jpeg;base64,...", "sortOrder": 1,
//       "sourcePath": null } ]
//
// `imageId` lets the gallery call DELETE without another round trip. But ids
// change on every coin save: PUT with `imagePaths` deletes and re-inserts all
// rows. A stale id matches nothing (the DELETE succeeds with no effect), never
// a different image. Nothing in the client calls the DELETE today; if that
// changes, re-fetch first or make PUT reconcile rows instead of replacing.
//
// `sourcePath` is the original file on the host, or null if unknown.
//
// The coin existing with no photos is 200 []; a missing coin is 404, hence the
// existence check first.
router.get('/:id/images', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Fetching images for coin ${id}`);

    const images = await withDb(async (db) => {
      const coin = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      // Null keeps the 404 out of the catch block.
      if (coin.recordset.length === 0) return null;

      const result = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT ImageId, ImageData, SortOrder, SourcePath FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      const origin = originFromRequest(req);

      return result.recordset.map((row: Record<string, unknown>) => ({
        imageId: row['ImageId'],
        // Referenced photo: return the URL of the file-streaming route.
        // image-payload.ts turns it back into "path, no picture" on save, so a
        // round trip can't convert it into a stored photo (see
        // routes/images/reference-url.ts).
        imageData: resolveImageData(row['ImageData'], row['SourcePath'], origin),
        sortOrder: row['SortOrder'],
        // NULL or missing column (pre-migration 002) become JSON null.
        sourcePath: (row['SourcePath'] as string | null | undefined) ?? null,
      }));
    });

    if (images === null) {
      logWarn(`Coin not found for image fetch: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Retrieved ${images.length} image(s) for coin ${id}`);
    // Sent separately so a serialization failure isn't reported as a database fault.
    sendJson(res, 'GET /api/coins/:id/images', images, "coin's photographs");
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id/images', err, 'Failed to retrieve images', "coin's photographs");
  }
});

// POST /api/coins/:id/images — add images to a coin
//
// Accepted request bodies — the FIRST form is the compatibility path:
//
//   { "images": ["data:image/jpeg;base64,...", ...] }        <- legacy, still works
//   { "images": [{ "imageData": "data:...", "sourcePath": "C:\\pics\\a.jpg" }] }
//   { "image": "data:..." } / { "imageData": "data:..." }    <- single image
//
// Bare strings are stored with SourcePath NULL. Parsing is in image-payload.ts.
// Transactional so a batch lands completely or not at all (a partial commit
// plus a retry would duplicate images).
router.post('/:id/images', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  // Collapse the accepted body shapes into one array.
  const rawImages: unknown[] = Array.isArray(req.body?.images)
    ? req.body.images
    : [req.body?.images ?? req.body?.image ?? req.body?.imageData];

  const images: NormalizedImage[] = normalizeImageEntries(rawImages);

  try {
    logInfo(`Adding ${images.length} image(s) to coin ${id}`);

    const insertedIds = await withDb(async (db) => {
      // Plain read outside the transaction: it only decides whether to do any work.
      const coin = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      if (coin.recordset.length === 0) return null;

      const transaction = new DbTransaction(db);

      // Only roll back a transaction that actually began.
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // Read inside the transaction so a concurrent insert can't invalidate it.
        const maxOrder = await new DbRequest(transaction)
          .input('coinId', DB_BINDINGS.coinId, id)
          .query('SELECT IFNULL(MAX(SortOrder), -1) AS max_order FROM CoinImages WHERE CoinId = @coinId');

        // Start from zero if the aggregate returns no row.
        let nextOrder = ((maxOrder.recordset[0]?.['max_order'] as number | undefined) ?? -1) + 1;

        const ids: number[] = [];
        for (const image of images) {
          const result = await new DbRequest(transaction)
            .input('coinId', DB_BINDINGS.coinId, id)
            // NULL is the referenced mode; normalizeImageEntries() guarantees
            // such a row has a SourcePath.
            .input('imageData', DB_BINDINGS.imageData, image.imageData)
            .input('sortOrder', DB_BINDINGS.sortOrder, nextOrder++)
            .input('sourcePath', DB_BINDINGS.imageSourcePath, image.sourcePath)
            .query(
              'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) VALUES (@coinId, @imageData, @sortOrder, @sourcePath) RETURNING ImageId'
            );

          const insertedRow = result.recordset[0];
          if (!insertedRow) {
            throw new Error('Image INSERT returned no row from its OUTPUT clause');
          }
          ids.push(insertedRow['ImageId'] as number);
        }

        await transaction.commit();
        return ids;
      } catch (innerErr) {
        await safeRollback(began ? transaction : null, 'POST /api/coins/:id/images');
        throw innerErr;
      }
    });

    if (insertedIds === null) {
      logWarn(`Coin not found for image add: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Added ${insertedIds.length} images to coin ${id}`);
    res.status(201).json({ imageIds: insertedIds });
  } catch (err) {
    sendDbError(res, 'POST /api/coins/:id/images', err, 'Failed to add image(s)');
  }
});

// DELETE /api/coins/:id/images/:imageId — remove a specific image
router.delete('/:id/images/:imageId', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const imageId = toSingleValue(req.params['imageId']);

  try {
    logInfo(`Deleting image ${imageId} from coin ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.imageId, Number.parseInt(imageId, 10))
        .input('coinId', DB_BINDINGS.coinId, id)
        .query('DELETE FROM CoinImages WHERE ImageId = @id AND CoinId = @coinId');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Image not found for deletion: ${imageId}`);
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    logInfo(`Image ${imageId} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/coins/:id/images/:imageId', err, 'Failed to delete image');
  }
});

export default router;
