/**
 * routes/lookups/mint-marks.ts — the MintMarks reference table.
 *
 * A mint mark is the little letter stamped on a coin ("D" = Denver) plus a
 * human-readable description. Like Denominations it uses a SOFT delete
 * (IsActive = 0) so historic coins keep their mark, and GET returns only the
 * active rows.
 *
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET    /mintmarks      -> active mint marks, ordered by label
 *   POST   /mintmarks      -> create one (returns the new MintMarkId)
 *   PUT    /mintmarks/:id  -> edit label / description
 *   DELETE /mintmarks/:id  -> soft-delete (IsActive = 0)
 *
 * Every database call runs inside `withDb()` and every parameter type comes
 * from DB_BINDINGS so it matches setup-database.sql. Note MintMarks.Label is
 * only NVARCHAR(20) — that short length is intentional and is one of the
 * columns the schema-drift test in db/coin-fields.spec.ts guards.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/mintmarks', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active mint marks');

    const mintmarks = await withDb(async (db) => {
      const result = await db.request()
        .query('SELECT MintMarkId, Label, Description FROM MintMarks WHERE IsActive = 1 ORDER BY Label');

      return result.recordset.map((row: Record<string, unknown>) => ({
        mintMarkId: row['MintMarkId'],
        label: row['Label'],
        description: row['Description'] ?? '',
        isActive: true,
      }));
    });

    res.json(mintmarks);
  } catch (err) {
    sendDbError(res, 'GET /api/mintmarks', err, 'Failed to retrieve mint marks');
  }
});

router.post('/mintmarks', async (req: Request, res: Response) => {
  const { label, description } = req.body ?? {};

  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }

  try {
    logInfo(`Creating mint mark: ${label}`);

    const id = await withDb(async (db) => {
      const result = await db.request()
        .input('label', DB_BINDINGS.mintMarkLabel, label.trim())
        .input('description', DB_BINDINGS.mintMarkDescription, description ?? null)
        .query(`
          INSERT INTO MintMarks (Label, Description, IsActive)
          OUTPUT INSERTED.MintMarkId
          VALUES (@label, @description, 1)
        `);

      const row = result.recordset[0];
      if (!row) throw new Error('Mint mark INSERT returned no row from its OUTPUT clause');
      return row['MintMarkId'];
    });

    logInfo(`Mint mark created with ID: ${id}`);
    res.status(201).json({
      mintMarkId: id,
      label: label.trim(),
      description,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'POST /api/mintmarks', err, 'Failed to create mint mark');
  }
});

router.put('/mintmarks/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const { label, description } = req.body ?? {};

  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }

  try {
    logInfo(`Updating mint mark ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.mintMarkId, Number.parseInt(id, 10))
        .input('label', DB_BINDINGS.mintMarkLabel, label.trim())
        .input('description', DB_BINDINGS.mintMarkDescription, description ?? null)
        .query(`
          UPDATE MintMarks
          SET Label = @label, Description = @description
          WHERE MintMarkId = @id
        `);
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Mint mark not found: ${id}`);
      res.status(404).json({ error: 'Mint mark not found' });
      return;
    }

    logInfo(`Mint mark ${id} updated successfully`);
    res.json({
      mintMarkId: Number.parseInt(id, 10),
      label: label.trim(),
      description,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'PUT /api/mintmarks/:id', err, 'Failed to update mint mark');
  }
});

router.delete('/mintmarks/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Soft-deleting mint mark ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.mintMarkId, Number.parseInt(id, 10))
        .query('UPDATE MintMarks SET IsActive = 0 WHERE MintMarkId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Mint mark not found: ${id}`);
      res.status(404).json({ error: 'Mint mark not found' });
      return;
    }

    logInfo(`Mint mark ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/mintmarks/:id', err, 'Failed to delete mint mark');
  }
});

export default router;
