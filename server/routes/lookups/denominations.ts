/**
 * routes/lookups/denominations.ts — the Denominations reference table.
 *
 * Unlike Categories and CoinSets, a denomination is a real row with an id, a
 * country and a sort order, and DELETE is a SOFT delete: it sets IsActive = 0
 * rather than removing the row, so coins that already reference the label keep
 * making sense. GET only ever returns the active ones.
 *
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET    /denominations      -> active denominations, ordered by country
 *   POST   /denominations      -> create one (returns the new DenominationId)
 *   PUT    /denominations/:id  -> rename / re-country / re-order one
 *   DELETE /denominations/:id  -> soft-delete (IsActive = 0)
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

router.get('/denominations', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active denominations');

    const denominations = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT DenominationId, Label, Country, SortOrder FROM Denominations WHERE IsActive = 1 ORDER BY Country, SortOrder');

      return result.recordset.map((row: Record<string, unknown>) => ({
        denominationId: row['DenominationId'],
        label: row['Label'],
        country: row['Country'],
        sortOrder: row['SortOrder'],
        isActive: true,
      }));
    });

    res.json(denominations);
  } catch (err) {
    sendDbError(res, 'GET /api/denominations', err, 'Failed to retrieve denominations');
  }
});

router.post('/denominations', async (req: Request, res: Response) => {
  const { label, country, sortOrder } = req.body ?? {};

  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }

  try {
    logInfo(`Creating denomination: ${label} (${country})`);

    const id = await withDb(async (db) => {
      const result = await db.request()
        .input('label', DB_BINDINGS.denominationLabel, label.trim())
        .input('country', DB_BINDINGS.denominationCountry, country ?? null)
        .input('sortOrder', DB_BINDINGS.denominationSortOrder, sortOrder ?? 0)
        .query(`
          INSERT INTO Denominations (Label, Country, SortOrder, IsActive)
          OUTPUT INSERTED.DenominationId
          VALUES (@label, @country, @sortOrder, 1)
        `);

      // Guard the OUTPUT clause rather than blindly dereferencing [0].
      const row = result.recordset[0];
      if (!row) throw new Error('Denomination INSERT returned no row from its OUTPUT clause');
      return row['DenominationId'];
    });

    logInfo(`Denomination created with ID: ${id}`);
    res.status(201).json({
      denominationId: id,
      label: label.trim(),
      country,
      sortOrder: sortOrder ?? 0,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'POST /api/denominations', err, 'Failed to create denomination');
  }
});

router.put('/denominations/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const { label, country, sortOrder } = req.body ?? {};

  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }

  try {
    logInfo(`Updating denomination ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.denominationId, Number.parseInt(id, 10))
        .input('label', DB_BINDINGS.denominationLabel, label.trim())
        .input('country', DB_BINDINGS.denominationCountry, country ?? null)
        .input('sortOrder', DB_BINDINGS.denominationSortOrder, sortOrder ?? 0)
        .query(`
          UPDATE Denominations
          SET Label = @label, Country = @country, SortOrder = @sortOrder
          WHERE DenominationId = @id
        `);
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Denomination not found: ${id}`);
      res.status(404).json({ error: 'Denomination not found' });
      return;
    }

    logInfo(`Denomination ${id} updated successfully`);
    res.json({
      denominationId: Number.parseInt(id, 10),
      label: label.trim(),
      country,
      sortOrder: sortOrder ?? 0,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'PUT /api/denominations/:id', err, 'Failed to update denomination');
  }
});

router.delete('/denominations/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Soft-deleting denomination ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.denominationId, Number.parseInt(id, 10))
        .query('UPDATE Denominations SET IsActive = 0 WHERE DenominationId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Denomination not found: ${id}`);
      res.status(404).json({ error: 'Denomination not found' });
      return;
    }

    logInfo(`Denomination ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/denominations/:id', err, 'Failed to delete denomination');
  }
});

export default router;
