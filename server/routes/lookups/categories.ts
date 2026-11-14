/**
 * routes/lookups/categories.ts — the Categories reference table.
 *
 * Categories is a plain list of names (Categories.CategoryName NVARCHAR(100)).
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET    /categories        -> list every category name
 *   POST   /categories        -> add one, ignoring case/whitespace duplicates
 *   DELETE /categories/:name  -> remove one
 *
 * Every database call runs inside `withDb()` (one automatic retry on a dropped
 * connection, never a pool teardown on an ordinary query error) and every
 * parameter type comes from DB_BINDINGS so it matches setup-database.sql.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/categories', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching categories');

    const names = await withDb(async (db) => {
      const result = await db.request().query('SELECT CategoryName FROM Categories ORDER BY CategoryName');
      return result.recordset.map((r: Record<string, unknown>) => r['CategoryName'] as string);
    });

    sendJson(res, 'GET /api/categories', names, 'category list');
  } catch (err) {
    sendDbError(res, 'GET /api/categories', err, 'Failed to retrieve categories', 'category list');
  }
});

router.post('/categories', async (req: Request, res: Response) => {
  const { name } = req.body ?? {};

  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const trimmedName = name.trim();

  try {
    logInfo(`Adding category: ${name}`);

    await withDb(async (db) => {
      await db.request()
        .input('name', DB_BINDINGS.categoryName, trimmedName)
        // `INSERT ... SELECT ... WHERE NOT EXISTS` rather than T-SQL's
        // `IF NOT EXISTS ... INSERT`: one statement, so the check and the
        // insert cannot be separated, and SQLite has no procedural IF.
        .query(`
          INSERT INTO Categories (CategoryName)
          SELECT @name
          WHERE NOT EXISTS (
            SELECT 1
            FROM Categories
            WHERE LOWER(LTRIM(RTRIM(CategoryName))) = LOWER(LTRIM(RTRIM(@name)))
          )
        `);
    });

    res.status(201).json({ name: trimmedName });
  } catch (err) {
    sendDbError(res, 'POST /api/categories', err, 'Failed to add category');
  }
});

router.delete('/categories/:name', async (req: Request, res: Response) => {
  const name = toSingleValue(req.params['name']);

  try {
    logInfo(`Deleting category: ${name}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.categoryName, name)
        .query('DELETE FROM Categories WHERE CategoryName = @name');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Category not found: ${name}`);
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    logInfo(`Category ${name} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/categories/:name', err, 'Failed to delete category');
  }
});

export default router;
