/**
 * Creating, updating and deleting a coin. Mounted at /api/coins:
 *
 *   POST   /      create a coin (+ images, catalogue references)
 *   PUT    /:id   partial update of a coin
 *   DELETE /:id   delete a coin (images and references cascade)
 *
 * - PUT builds its UPDATE from only the keys present in the body; writing
 *   every column would blank the user's data.
 * - PUT with `imagePaths` replaces the image set but keeps recorded
 *   SourcePaths (see replaceImages() in write-helpers.ts).
 *
 * `imagePaths` is a historical name: it holds image data, each element either
 * a bare base64 string or `{ imageData, sourcePath }` (see image-payload.ts).
 * It is one array rather than two parallel ones so a path can never shift
 * onto the wrong photo.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { logInfo, logWarn } from '../../logger';
import { withDb, COIN_FIELDS, DB_BINDINGS, normalizeCoinValue, DbRequest, DbTransaction } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback, insertImages, replaceImages } from './write-helpers';
import { insertCatalogRefs, replaceCatalogRefs } from './catalog-refs';

const router = Router();

// POST /api/coins — create a new coin with optional images
router.post('/', async (req: Request, res: Response) => {
  const body = req.body ?? {};

  // Validate before opening a transaction.
  if (!body.denomination) {
    res.status(400).json({ error: 'denomination is required' });
    return;
  }

  const id = body.id || crypto.randomUUID();

  try {
    logInfo(`Creating new coin ${id}`);

    await withDb(async (db) => {
      const transaction = new DbTransaction(db);

      // Only roll back a transaction that actually began.
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // Built from COIN_FIELDS, shared with the UPDATE in PUT /:id.
        const insertRequest = new DbRequest(transaction)
          .input('id', DB_BINDINGS.coinId, id);

        const columnNames: string[] = ['CoinId'];
        const parameterNames: string[] = ['@id'];

        for (const [key, binding] of Object.entries(COIN_FIELDS)) {
          // Create writes every column: the supplied value or the field's default.
          const rawValue = Object.prototype.hasOwnProperty.call(body, key)
            ? body[key]
            : binding.insertDefault;

          insertRequest.input(key, binding.sqlType, normalizeCoinValue(key, rawValue));
          columnNames.push(binding.column);
          parameterNames.push(`@${key}`);
        }

        await insertRequest.query(
          `INSERT INTO Coins (${columnNames.join(', ')}) VALUES (${parameterNames.join(', ')})`
        );

        await insertImages(transaction, id, body.imagePaths ?? []);
        await insertCatalogRefs(transaction, id, body.catalogRefs ?? []);

        await transaction.commit();
      } catch (innerErr) {
        await safeRollback(began ? transaction : null, 'POST /api/coins');
        throw innerErr;
      }
    });

    logInfo(`Coin ${id} created successfully`);
    res.status(201).json({ id });
  } catch (err) {
    sendDbError(res, 'POST /api/coins', err, 'Failed to create coin');
  }
});

// PUT /api/coins/:id — update an existing coin
router.put('/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const body = req.body ?? {};

  try {
    logInfo(`Updating coin ${id}`);

    const updated = await withDb(async (db) => {
      const existing = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      // A return value keeps the 404 out of the error classifier.
      if (existing.recordset.length === 0) return false;

      const transaction = new DbTransaction(db);
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // Partial update: only keys present in the body are written, so
        // { coinType: 'Morgan' } must update CoinType alone.
        const updateEntries = Object.entries(COIN_FIELDS)
          .filter(([key]) => Object.prototype.hasOwnProperty.call(body, key))
          .map(([key, binding]) => ({ key, ...binding }));

        if (updateEntries.length > 0) {
          const updateRequest = new DbRequest(transaction)
            .input('id', DB_BINDINGS.coinId, id);

          for (const entry of updateEntries) {
            updateRequest.input(entry.key, entry.sqlType, normalizeCoinValue(entry.key, body[entry.key]));
          }

          const clauseText = updateEntries
            .map((entry) => `${entry.column} = @${entry.key}`)
            .join(', ');

          await updateRequest.query(`UPDATE Coins SET ${clauseText} WHERE CoinId = @id`);
        }

        // Only when the body has an imagePaths key; otherwise a partial edit
        // would delete every image. replaceImages() keeps the read-delete-insert
        // order on one transaction.
        if (Object.prototype.hasOwnProperty.call(body, 'imagePaths')) {
          await replaceImages(transaction, id, body.imagePaths ?? []);
        }

        // Same rule for references: only replaced when the key is present.
        if (Object.prototype.hasOwnProperty.call(body, 'catalogRefs')) {
          await replaceCatalogRefs(transaction, id, body.catalogRefs ?? []);
        }

        await transaction.commit();
        return true;
      } catch (innerErr) {
        await safeRollback(began ? transaction : null, 'PUT /api/coins/:id');
        throw innerErr;
      }
    });

    if (!updated) {
      logWarn(`Coin not found for update: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Coin ${id} updated successfully`);
    res.json({ id });
  } catch (err) {
    sendDbError(res, 'PUT /api/coins/:id', err, 'Failed to update coin');
  }
});

// DELETE /api/coins/:id — deletes coin (images cascade)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Deleting coin ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('DELETE FROM Coins WHERE CoinId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Coin not found for deletion: ${id}`);
      res.status(404).json({ error: 'Coin not found' });
      return;
    }

    logInfo(`Coin ${id} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/coins/:id', err, 'Failed to delete coin');
  }
});

export default router;
