/**
 * The Denominations reference table. DELETE is a soft delete (IsActive = 0)
 * and GET returns only active rows. Mounted at /api:
 *
 *   GET    /denominations      active denominations, ordered by country
 *   POST   /denominations      create one (returns the new DenominationId)
 *   PUT    /denominations/:id  rename / re-country / re-order one
 *   DELETE /denominations/:id  soft-delete and unlink its coins
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS, DbRequest, DbTransaction } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback } from '../coins/write-helpers';

const router = Router();

router.get('/denominations', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active denominations');

    const denominations = await withDb(async (db) => {
      // LEFT JOIN: IssuerId is nullable, and unmatched rows must still be listed
      // so the maintenance screen can assign them an issuer.
      const result = await db.request()
        .query(
          'SELECT d.DenominationId, d.Label, d.Country, d.IssuerId, d.FaceValue, d.SortOrder, ' +
            'i.Name AS IssuerName ' +
            'FROM Denominations d LEFT JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
            'WHERE d.IsActive = 1 ORDER BY d.Country, d.SortOrder'
        );

      return result.recordset.map((row: Record<string, unknown>) => ({
        denominationId: row['DenominationId'],
        label: row['Label'],
        country: row['Country'],
        // Grouping fields for the maintenance screen; `country` stays for the
        // coin editor's dropdown.
        issuerId: row['IssuerId'] ?? null,
        issuerName: row['IssuerName'] ?? null,
        faceValue: row['FaceValue'] ?? null,
        sortOrder: row['SortOrder'],
        isActive: true,
      }));
    });

    sendJson(res, 'GET /api/denominations', denominations, 'denomination list');
  } catch (err) {
    sendDbError(res, 'GET /api/denominations', err, 'Failed to retrieve denominations', 'denomination list');
  }
});

router.post('/denominations', async (req: Request, res: Response) => {
  const { label, country, sortOrder, issuerId } = req.body ?? {};

  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }

  // Optional here (the editor's older add path doesn't send it); the
  // maintenance screen requires it. Absent means null.
  const resolvedIssuerId = Number.isInteger(Number(issuerId)) && Number(issuerId) > 0
    ? Number(issuerId)
    : null;

  try {
    logInfo(`Creating denomination: ${label} (issuer ${resolvedIssuerId ?? 'none'})`);

    const id = await withDb(async (db) => {
      const result = await db.request()
        .input('label', DB_BINDINGS.denominationLabel, label.trim())
        .input('country', DB_BINDINGS.denominationCountry, country ?? null)
        .input('issuerId', DB_BINDINGS.denominationIssuerId, resolvedIssuerId)
        .input('sortOrder', DB_BINDINGS.denominationSortOrder, sortOrder ?? 0)
        .query(`
          INSERT INTO Denominations (Label, Country, IssuerId, SortOrder, IsActive)
          VALUES (@label, @country, @issuerId, @sortOrder, 1)
          RETURNING DenominationId
        `);

      // Guard against an empty RETURNING result.
      const row = result.recordset[0];
      if (!row) throw new Error('Denomination INSERT returned no row from its OUTPUT clause');
      return row['DenominationId'];
    });

    logInfo(`Denomination created with ID: ${id}`);
    res.status(201).json({
      denominationId: id,
      label: label.trim(),
      country,
      issuerId: resolvedIssuerId,
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

/*
 * DELETE: soft-delete the denomination and NULL its coins' DenominationId, in
 * one transaction. Coins.Denomination (the recorded text) is never touched,
 * so re-selecting a denomination relinks a coin and nothing is lost.
 *
 * The coins are unlinked explicitly (rather than left pointing at an inactive
 * row) so that reactivating the row later can't silently relink coins the user
 * detached. Coins are updated first so a failure never leaves coins pointing
 * at a row the API no longer returns. The UI shows the coin count beforehand
 * via GET /api/reference-usage.
 */
router.delete('/denominations/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Soft-deleting denomination ${id} and unlinking its coins`);

    const outcome = await withDb(async (db) => {
      const transaction = new DbTransaction(db);
      let began = false;

      try {
        await transaction.begin();
        began = true;

        const unlinked = await new DbRequest(transaction)
          .input('id', DB_BINDINGS.denominationId, Number.parseInt(id, 10))
          .query('UPDATE Coins SET DenominationId = NULL WHERE DenominationId = @id');

        const deactivated = await new DbRequest(transaction)
          .input('id', DB_BINDINGS.denominationId, Number.parseInt(id, 10))
          .query('UPDATE Denominations SET IsActive = 0 WHERE DenominationId = @id');

        await transaction.commit();

        return {
          removed: deactivated.rowsAffected[0] ?? 0,
          coinsUnlinked: unlinked.rowsAffected[0] ?? 0,
        };
      } catch (innerErr) {
        await safeRollback(began ? transaction : null, 'DELETE /api/denominations/:id');
        throw innerErr;
      }
    });

    if (outcome.removed === 0) {
      // Not found; the FK means no coins could point at it either.
      logWarn(`Denomination not found: ${id}`);
      res.status(404).json({ error: 'Denomination not found' });
      return;
    }

    logInfo(`Denomination ${id} soft-deleted; ${outcome.coinsUnlinked} coin(s) unlinked`);
    res.json({ denominationId: Number.parseInt(id, 10), coinsUnlinked: outcome.coinsUnlinked });
  } catch (err) {
    sendDbError(res, 'DELETE /api/denominations/:id', err, 'Failed to delete denomination');
  }
});

export default router;
