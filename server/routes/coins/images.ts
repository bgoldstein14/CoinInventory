/**
 * routes/coins/images.ts — the coin image sub-resource.
 *
 * Images are stored as base64 text in the CoinImages table, one row per image,
 * ordered by SortOrder. Mounted (via routes/coins/index.ts) at /api/coins:
 *
 *   GET    /:id/images            -> GET    /api/coins/:id/images
 *   POST   /:id/images            -> POST   /api/coins/:id/images
 *   DELETE /:id/images/:imageId   -> DELETE /api/coins/:id/images/:imageId
 *
 * The GET is the on-demand half of the "don't ship every image on every app
 * load" fix: GET /api/coins can now be asked to omit image payloads (see
 * routes/coins/list-query.ts) and the detail panel / gallery pulls the full
 * images for the single coin the user is actually looking at from here.
 *
 * Note that adding images here APPENDS to whatever the coin already has, while
 * `PUT /api/coins/:id` with an `imagePaths` key REPLACES the whole set. Both
 * behaviours are deliberate; see routes/coins/writes.ts.
 *
 * Each image also carries an optional `sourcePath`: the absolute path of the
 * ORIGINAL full-resolution file on the machine hosting the app. ImageData is
 * only a downscaled copy, so SourcePath is what lets the UI link to the real
 * photo and show the user where it came from. Serving that file is a separate
 * concern and lives in routes/images/ — which also explains why the backend has
 * to serve it at all instead of the browser opening it directly.
 *
 * Every database call goes through `withDb()` and there are no resetPool()
 * calls — see db/index.ts for why that matters.
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback } from './write-helpers';
import { normalizeImageEntries, type NormalizedImage } from './image-payload';

const router = Router();

// ============================================================
// GET /api/coins/:id/images — full images for ONE coin, in display order
// ============================================================
//
// Response shape (an array, ordered by SortOrder):
//
//   [ { "imageId": 12, "imageData": "data:image/jpeg;base64,...", "sortOrder": 0,
//       "sourcePath": "C:\\Coin Pictures\\1921-morgan-obverse.jpg" },
//     { "imageId": 13, "imageData": "data:image/jpeg;base64,...", "sortOrder": 1,
//       "sourcePath": null } ]
//
// `imageId` is what DELETE /api/coins/:id/images/:imageId needs, so returning
// it here lets the gallery delete an image without another round trip.
//
// `sourcePath` is where the ORIGINAL full-resolution file lives on the host
// machine (imageData is only a downscaled copy). It is null for every image
// imported before that column existed, and the UI treats null as "no link to
// offer". Having it here is what lets the detail view show the file's location
// and, after one POST /api/images/exists round trip, grey out the link for
// files that have since been moved or deleted.
//
// Two "nothing found" cases that are deliberately NOT the same thing:
//   - the coin exists but has no photos  -> 200 with []   (a normal, valid state)
//   - the coin does not exist at all     -> 404           (a real error)
// Hence the cheap existence check before the image query: without it we could
// not tell those two apart, because both produce an empty image recordset.
router.get('/:id/images', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Fetching images for coin ${id}`);

    const images = await withDb(async (db) => {
      // Existence check first. SELECT CoinId (not *) because all we need to
      // know is whether a row is there — the coin's own columns are irrelevant.
      const coin = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      // Returning null (rather than throwing) keeps the 404 out of the catch
      // block, matching the pattern used by the other coin handlers.
      if (coin.recordset.length === 0) return null;

      const result = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT ImageId, ImageData, SortOrder, SourcePath FROM CoinImages WHERE CoinId = @id ORDER BY SortOrder');

      // SQL's ORDER BY has already done the sorting; recordset order is the
      // display order, so we just translate CamelCase columns to camelCase JSON.
      return result.recordset.map((row: Record<string, unknown>) => ({
        imageId: row['ImageId'],
        imageData: row['ImageData'],
        sortOrder: row['SortOrder'],
        // Normalise SQL NULL (and a driver that omits the column entirely, as
        // happens against a database where migration 002 has not been run yet)
        // to JSON null, so the client only ever has one "unknown" to handle.
        sourcePath: (row['SourcePath'] as string | null | undefined) ?? null,
      }));
    });

    if (images === null) {
      logWarn(`Coin not found for image fetch: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Retrieved ${images.length} image(s) for coin ${id}`);
    res.json(images);
  } catch (err) {
    sendDbError(res, 'GET /api/coins/:id/images', err, 'Failed to retrieve images');
  }
});

// ============================================================
// POST /api/coins/:id/images — add images to a coin
// ============================================================
//
// Accepted request bodies — the FIRST form is the compatibility path:
//
//   { "images": ["data:image/jpeg;base64,...", ...] }        <- legacy, still works
//   { "images": [{ "imageData": "data:...", "sourcePath": "C:\\pics\\a.jpg" }] }
//   { "image": "data:..." } / { "imageData": "data:..." }    <- single image
//
// A bare string carries no source path, so it is stored with SourcePath NULL —
// identical to how every pre-existing row looks. The per-element parsing lives
// in image-payload.ts; see normalizeImageEntry() for the exact rules.
//
// ------------------------------------------------------------------
// This handler is TRANSACTIONAL, and that is a bug fix
// ------------------------------------------------------------------
// The insert loop used to run each INSERT as its own autocommit statement. If
// image 5 of 8 failed, images 1-4 were already committed, the caller got a 500,
// and pressing "retry" inserted 1-4 a second time — duplicates the user then
// had to delete by hand. Wrapping the batch in one transaction makes a failure
// leave the coin exactly as it was, which is also how insertImages() (used by
// POST /api/coins and PUT /api/coins/:id) has always behaved. The two paths are
// now consistent: an image batch either lands completely or not at all.
router.post('/:id/images', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  // Collapse the three accepted body shapes into one array before we go
  // anywhere near the database. `images` is the array form; `image` /
  // `imageData` are the single-image convenience keys.
  const rawImages: unknown[] = Array.isArray(req.body?.images)
    ? req.body.images
    : [req.body?.images ?? req.body?.image ?? req.body?.imageData];

  const images: NormalizedImage[] = normalizeImageEntries(rawImages);

  try {
    logInfo(`Adding ${images.length} image(s) to coin ${id}`);

    const insertedIds = await withDb(async (db) => {
      // The existence check is a plain read and stays outside the transaction:
      // it decides whether we do any work at all, and holding a transaction
      // open across it would buy nothing.
      const coin = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      if (coin.recordset.length === 0) return null;

      const transaction = new sql.Transaction(db);

      // `began` tracks whether begin() actually succeeded, so safeRollback is
      // never handed a transaction that was never started.
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // MAX(SortOrder) is read INSIDE the transaction now, so it cannot be
        // invalidated by a concurrent insert between reading it and using it.
        const maxOrder = await new sql.Request(transaction)
          .input('coinId', DB_BINDINGS.coinId, id)
          .query('SELECT ISNULL(MAX(SortOrder), -1) AS max_order FROM CoinImages WHERE CoinId = @coinId');

        // Defensive: an aggregate always returns a row, but if the driver hands
        // us an empty recordset we start from zero rather than crashing.
        let nextOrder = ((maxOrder.recordset[0]?.['max_order'] as number | undefined) ?? -1) + 1;

        const ids: number[] = [];
        for (const image of images) {
          const result = await new sql.Request(transaction)
            .input('coinId', DB_BINDINGS.coinId, id)
            .input('imageData', DB_BINDINGS.imageData, image.imageData)
            .input('sortOrder', DB_BINDINGS.sortOrder, nextOrder++)
            .input('sourcePath', DB_BINDINGS.imageSourcePath, image.sourcePath)
            .query(
              'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) OUTPUT INSERTED.ImageId VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
            );

          // Guard the OUTPUT clause the same way as the spot-price insert: if
          // the driver returns no row we must not dereference undefined.
          const insertedRow = result.recordset[0];
          if (!insertedRow) {
            throw new Error('Image INSERT returned no row from its OUTPUT clause');
          }
          ids.push(insertedRow['ImageId'] as number);
        }

        await transaction.commit();
        return ids;
      } catch (innerErr) {
        // Roll back WITHOUT letting a rollback failure mask the real cause.
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
