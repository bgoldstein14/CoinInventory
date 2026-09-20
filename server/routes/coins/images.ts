/**
 * routes/coins/images.ts — the coin image sub-resource.
 *
 * Images are stored as base64 text in the CoinImages table, one row per image,
 * ordered by SortOrder. Mounted (via routes/coins/index.ts) at /api/coins:
 *
 *   POST   /:id/images            -> POST   /api/coins/:id/images
 *   DELETE /:id/images/:imageId   -> DELETE /api/coins/:id/images/:imageId
 *
 * Note that adding images here APPENDS to whatever the coin already has, while
 * `PUT /api/coins/:id` with an `imagePaths` key REPLACES the whole set. Both
 * behaviours are deliberate; see routes/coins/writes.ts.
 *
 * Every database call goes through `withDb()` and there are no resetPool()
 * calls — see db/index.ts for why that matters.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

// ============================================================
// POST /api/coins/:id/images — add images to a coin
// ============================================================
router.post('/:id/images', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Adding images to coin ${id}`);

    const insertedIds = await withDb(async (db) => {
      const coin = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      if (coin.recordset.length === 0) return null;

      const maxOrder = await db.request()
        .input('coinId', DB_BINDINGS.coinId, id)
        .query('SELECT ISNULL(MAX(SortOrder), -1) AS max_order FROM CoinImages WHERE CoinId = @coinId');

      // Defensive: an aggregate always returns a row, but if the driver hands
      // us an empty recordset we start from zero rather than crashing.
      let nextOrder = ((maxOrder.recordset[0]?.['max_order'] as number | undefined) ?? -1) + 1;

      const images: string[] = Array.isArray(req.body?.images)
        ? req.body.images
        : [req.body?.image ?? req.body?.imageData];

      const ids: number[] = [];
      for (const imageData of images) {
        if (!imageData) continue;
        const result = await db.request()
          .input('coinId', DB_BINDINGS.coinId, id)
          .input('imageData', DB_BINDINGS.imageData, imageData)
          .input('sortOrder', DB_BINDINGS.sortOrder, nextOrder++)
          .query('INSERT INTO CoinImages (CoinId, ImageData, SortOrder) OUTPUT INSERTED.ImageId VALUES (@coinId, @imageData, @sortOrder)');

        // Guard the OUTPUT clause the same way as the spot-price insert: if
        // the driver returns no row we must not dereference undefined.
        const insertedRow = result.recordset[0];
        if (!insertedRow) {
          throw new Error('Image INSERT returned no row from its OUTPUT clause');
        }
        ids.push(insertedRow['ImageId'] as number);
      }

      return ids;
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

// ============================================================
// DELETE /api/coins/:id/images/:imageId — remove a specific image
// ============================================================
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
