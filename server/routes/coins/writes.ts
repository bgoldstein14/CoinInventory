/**
 * routes/coins/writes.ts — creating, updating and deleting a coin.
 *
 * Mounted (via routes/coins/index.ts) at /api/coins, so the paths below are
 * relative to that:
 *
 *   POST   /      -> POST   /api/coins       create a coin (+ images, tags)
 *   PUT    /:id   -> PUT    /api/coins/:id   partial update of a coin
 *   DELETE /:id   -> DELETE /api/coins/:id   delete a coin (cascades)
 *
 * ------------------------------------------------------------------
 * Two things in here are load-bearing; please read before editing.
 * ------------------------------------------------------------------
 *
 * 1. Every handler runs its database work inside `withDb(async (db) => ...)`.
 *    withDb hands us a healthy pool and, if the *connection* dies mid-call,
 *    rebuilds the pool and retries exactly once. It does NOT retry ordinary
 *    query errors.
 *
 *    This replaced the old pattern of `await getPool()` plus `await resetPool()`
 *    in every catch block. resetPool() destroys the pool shared by the entire
 *    process, so a single validation error or constraint violation used to
 *    break every other request that was in flight at the time. There must be
 *    no resetPool() calls in this file.
 *
 * 2. PUT /:id builds its UPDATE statement from ONLY the keys actually present
 *    in the request body. A previous refactor wrote every column on every save
 *    and blanked out the user's data. Do not "simplify" that filter.
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import crypto from 'crypto';
import { logInfo, logWarn } from '../../logger';
import { withDb, COIN_FIELDS, DB_BINDINGS, normalizeCoinValue } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback, insertImages, insertTags } from './write-helpers';

const router = Router();

// ============================================================
// POST /api/coins — create a new coin with optional images/tags
// ============================================================
router.post('/', async (req: Request, res: Response) => {
  const body = req.body ?? {};

  // Validate before we touch the database so a bad request never opens a
  // transaction (and never reaches the generic error classifier).
  if (!body.denomination) {
    res.status(400).json({ error: 'denomination is required' });
    return;
  }

  const id = body.id || crypto.randomUUID();

  try {
    logInfo(`Creating new coin ${id}`);

    await withDb(async (db) => {
      const transaction = new sql.Transaction(db);

      // `began` tracks whether begin() actually succeeded, so we never try to
      // roll back a transaction that was never started.
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // Build the INSERT from the shared COIN_FIELDS map so it can never
        // drift away from the UPDATE in PUT /:id or from setup-database.sql.
        const insertRequest = new sql.Request(transaction)
          .input('id', DB_BINDINGS.coinId, id);

        const columnNames: string[] = ['CoinId'];
        const parameterNames: string[] = ['@id'];

        for (const [key, binding] of Object.entries(COIN_FIELDS)) {
          // On create we write every column: either the supplied value or the
          // field's documented default (null for most, 0 for the BIT column,
          // 'manual' for Source).
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
        await insertTags(transaction, id, body.tags ?? []);

        await transaction.commit();
      } catch (innerErr) {
        // Roll back WITHOUT letting a rollback failure mask the real cause.
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

// ============================================================
// PUT /api/coins/:id — update an existing coin
// ============================================================
router.put('/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const body = req.body ?? {};

  try {
    logInfo(`Updating coin ${id}`);

    const updated = await withDb(async (db) => {
      const existing = await db.request()
        .input('id', DB_BINDINGS.coinId, id)
        .query('SELECT CoinId FROM Coins WHERE CoinId = @id');

      // Signal "not found" with a return value so the 404 stays out of the
      // error classifier below.
      if (existing.recordset.length === 0) return false;

      const transaction = new sql.Transaction(db);
      let began = false;

      try {
        await transaction.begin();
        began = true;

        // ****************************************************************
        // *** PARTIAL-UPDATE SEMANTICS — DO NOT SIMPLIFY ***
        // Only columns whose key is actually present in the request body are
        // written. If the frontend sends { coinType: 'Morgan' } we must emit
        // `UPDATE Coins SET CoinType = @coinType`, NOT a statement that also
        // sets Denomination, Year, Notes, ... to null. A previous refactor
        // did exactly that and wiped out the user's data.
        // ****************************************************************
        const updateEntries = Object.entries(COIN_FIELDS)
          .filter(([key]) => Object.prototype.hasOwnProperty.call(body, key))
          .map(([key, binding]) => ({ key, ...binding }));

        if (updateEntries.length > 0) {
          const updateRequest = new sql.Request(transaction)
            .input('id', DB_BINDINGS.coinId, id);

          for (const entry of updateEntries) {
            updateRequest.input(entry.key, entry.sqlType, normalizeCoinValue(entry.key, body[entry.key]));
          }

          const clauseText = updateEntries
            .map((entry) => `${entry.column} = @${entry.key}`)
            .join(', ');

          await updateRequest.query(`UPDATE Coins SET ${clauseText} WHERE CoinId = @id`);
        }

        // Images are replaced (delete-then-insert), so this block must ONLY
        // run when the caller explicitly sent an imagePaths key. Running it
        // unconditionally would delete every image on a partial edit.
        if (Object.prototype.hasOwnProperty.call(body, 'imagePaths')) {
          await new sql.Request(transaction)
            .input('coinId', DB_BINDINGS.coinId, id)
            .query('DELETE FROM CoinImages WHERE CoinId = @coinId');

          await insertImages(transaction, id, body.imagePaths ?? []);
        }

        // Same reasoning as images: replacement is destructive, so only do it
        // when the key was explicitly supplied.
        if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
          await new sql.Request(transaction)
            .input('coinId', DB_BINDINGS.coinId, id)
            .query('DELETE FROM CoinTags WHERE CoinId = @coinId');

          await insertTags(transaction, id, body.tags ?? []);
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

// ============================================================
// DELETE /api/coins/:id — deletes coin (images/tags cascade)
// ============================================================
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
