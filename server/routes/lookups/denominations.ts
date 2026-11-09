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
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/denominations', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active denominations');

    const denominations = await withDb(async (db) => {
      // A LEFT JOIN, not an inner one. Denominations.IssuerId is nullable and
      // a row the seed never reached still has none. Dropping those rows here
      // would hide them from the one screen that can give them an issuer.
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
        // The fields the maintenance screen groups by. ADDED alongside
        // `country` rather than replacing it: the coin editor's dropdown
        // still groups by Country, so removing it here would empty that
        // dropdown's headings.
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

  // issuerId is OPTIONAL here and REQUIRED by the maintenance screen, and
  // the asymmetry is deliberate: the column is nullable, the editor's older
  // add path does not send one, and rejecting those would break a working
  // caller to enforce a rule that belongs to the UI. Absent means null, the
  // same state the seed leaves an unmatched row in.
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
          OUTPUT INSERTED.DenominationId
          VALUES (@label, @country, @issuerId, @sortOrder, 1)
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
 * DELETE — a soft delete that leaves Coins.Denomination alone
 *   1. Count the coins using it, and say the number plainly.   <- the UI, via
 *                                                                 GET /api/
 *                                                                 reference-usage
 *   2. If confirmed: soft-delete (IsActive = 0) and NULL those coins'
 *      DenominationId.                                          <- here
 *   3. Coins.Denomination text is NEVER touched.                <- here
 *   4. Re-selecting a denomination re-links them. Nothing is lost.
 *
 * *** STEP 3 IS THE RULE THAT MAKES EVERYTHING ELSE RECOVERABLE. ***
 * Coins.Denomination is never written. It holds what the SOURCE
 * said — typed by the user or read out of a QIF — and after this runs it is
 * the only record of what the coin was. It is what lets the user recognise
 * the row, and it is what denomination-display.ts renders the unresolved
 * form from. A delete that blanked it would turn a reversible unlink into
 * data loss, so this statement sets exactly one column and that column is
 * DenominationId.
 *
 * WHY STEP 2 IS NOT LEFT TO THE SOFT DELETE ALONE. A coin still pointing at
 * a deactivated row displays as unresolved anyway, because the row no longer
 * comes back from GET — but by accident rather than by design, and the state
 * is a lie: the coin claims a link to a denomination that is not on offer.
 * Reactivating the row would silently re-link coins the user had already
 * decided to detach. Nulling makes the user's decision real.
 *
 * WHY ONE BATCH, AND WHY COINS FIRST.
 * One `query()` call, so a connection dropped between the two statements
 * cannot leave the job half done. Coins first because FK_Coins_Denomination
 * guarantees no coin points at a denomination that does not exist, which
 * makes unlinking-then-deactivating safe in every order of failure;
 * deactivating first would open a window — and on a failure, a permanent
 * state — in which coins point at a row the API no longer returns.
 *
 * `@@ROWCOUNT` is captured into a variable immediately after the first
 * UPDATE, because the next statement resets it. The trailing SELECT reports
 * both numbers: whether a row was there at all (404 if not) and how many
 * coins were unlinked, so the UI can confirm what just happened with the
 * same number it warned about.
  */
router.delete('/denominations/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Soft-deleting denomination ${id} and unlinking its coins`);

    const outcome = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.denominationId, Number.parseInt(id, 10))
        .query(`
          UPDATE Coins SET DenominationId = NULL WHERE DenominationId = @id;
          DECLARE @unlinked INT = @@ROWCOUNT;
          UPDATE Denominations SET IsActive = 0 WHERE DenominationId = @id;
          SELECT @@ROWCOUNT AS Removed, @unlinked AS CoinsUnlinked;
        `);

      const row = result.recordset[0] ?? {};
      return {
        removed: Number(row['Removed'] ?? 0),
        coinsUnlinked: Number(row['CoinsUnlinked'] ?? 0),
      };
    });

    if (outcome.removed === 0) {
      // Nothing was changed: the FK means a denomination that does not exist
      // can have no coins pointing at it, so the first UPDATE was a no-op too.
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
