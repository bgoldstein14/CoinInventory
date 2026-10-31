/**
 * routes/lookups/coin-sets.ts — the CoinSets reference table.
 *
 * A coin set is a named grouping ("1964 Proof Set") that a coin can belong to
 * via Coins.CoinSet. Like Categories it is a plain list of names
 * (CoinSets.SetName NVARCHAR(100)). Mounted (via routes/lookups/index.ts)
 * at /api:
 *
 *   GET    /coin-sets        -> list every set name
 *   POST   /coin-sets        -> add one (exact-match duplicate check)
 *   DELETE /coin-sets/:name  -> remove one
 *
 * Note the duplicate check here is an exact SetName match, whereas Categories
 * compares case- and whitespace-insensitively. That difference is pre-existing
 * behaviour and has been carried over unchanged.
 *
 * Every database call runs inside `withDb()` and every parameter type comes
 * from DB_BINDINGS so it matches setup-database.sql.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/coin-sets', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching coin sets');

    const names = await withDb(async (db) => {
      const result = await db.request().query('SELECT SetName FROM CoinSets ORDER BY SetName');
      return result.recordset.map((r: Record<string, unknown>) => r['SetName'] as string);
    });

    res.json(names);
  } catch (err) {
    sendDbError(res, 'GET /api/coin-sets', err, 'Failed to retrieve coin sets');
  }
});

router.post('/coin-sets', async (req: Request, res: Response) => {
  const { name } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const trimmedName = name.trim();

  try {
    logInfo(`Adding coin set: ${name}`);

    await withDb(async (db) => {
      await db.request()
        .input('name', DB_BINDINGS.setName, trimmedName)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM CoinSets WHERE SetName = @name)
            INSERT INTO CoinSets (SetName) VALUES (@name)
        `);
    });

    res.status(201).json({ name: trimmedName });
  } catch (err) {
    sendDbError(res, 'POST /api/coin-sets', err, 'Failed to add coin set');
  }
});

router.delete('/coin-sets/:name', async (req: Request, res: Response) => {
  const name = toSingleValue(req.params['name']);

  try {
    logInfo(`Deleting coin set: ${name}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.setName, name)
        .query('DELETE FROM CoinSets WHERE SetName = @name');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Coin set not found: ${name}`);
      res.status(404).json({ error: 'Coin set not found' });
      return;
    }

    logInfo(`Coin set ${name} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/coin-sets/:name', err, 'Failed to delete coin set');
  }
});

export default router;
