/**
 * routes/lookups/catalogs.ts — the Catalogs reference table (migration 012).
 *
 * A catalogue is the book a coin is attributed in: Sear, RIC, Hendin,
 * Crawford, Krause. The coin stores the catalogue's ID plus a free-text
 * number ("6819", "II.1 234"), and the two read together as "Sear 6819".
 *
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET    /catalogs      -> active catalogues, in picker order
 *   POST   /catalogs      -> create one (returns the new CatalogId)
 *   PUT    /catalogs/:id  -> rename it
 *   DELETE /catalogs/:id  -> soft-delete (IsActive = 0)
 *
 * This file is deliberately a near-copy of mint-marks.ts. It is the same kind
 * of table, maintained from the same screen, with the same soft delete, so
 * anyone who has read that one has read this one. Resist making it cleverer
 * than its neighbours.
 *
 * TWO THINGS HERE ARE NOT INTERCHANGEABLE WITH THE OTHER LOOKUPS
 * 1. THE DELETE MUST STAY SOFT. See the note on the handler: a hard delete
 *    fails against FK_Coins_Catalog, and the "obvious fix" of adding a
 *    cascade would delete coins.
 *
 * 2. PUT RENAMES IN PLACE, KEEPING THE ID. That is the whole reason the
 *    route exists: coins reference the row by id, so remove-and-re-add
 *    (which is all the other lookups offer) would silently orphan every coin
 *    attributed to it. A user expanding "RIC" to "RIC (Roman Imperial
 *    Coinage)" must not lose a hundred attributions to a presentation
 *    preference.
 *
 * Every database call runs inside `withDb()` and every parameter type comes
 * from DB_BINDINGS so it matches setup-database.sql. Catalogs.Name is
 * NVARCHAR(60); the Angular side caps its input at the same number via
 * CATALOG_NAME_MAX_LENGTH in src/app/types/catalog-reference.ts.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/catalogs', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active catalogues');

    const catalogs = await withDb(async (db) => {
      const result = await db.request()
        // ORDER BY SortOrder, NOT by Name. The seed numbers the catalogues
        // 1..15 in the order THIS collection uses them, so the picker opens
        // on Sear. Alphabetical order would lead with BMC and bury Sear in
        // eleventh place, which is a worse dropdown for the one user there
        // is. The id is the tiebreak so the order is total and stable --
        // user-added rows all share no particular SortOrder otherwise.
        .query(
          'SELECT CatalogId, Name, SortOrder FROM Catalogs ' +
            'WHERE IsActive = 1 ORDER BY SortOrder, CatalogId'
        );

      return result.recordset.map((row: Record<string, unknown>) => ({
        catalogId: row['CatalogId'],
        name: row['Name'],
        sortOrder: row['SortOrder'] ?? 0,
        // Always true: the query already filtered on it. Returned anyway so
        // the wire shape matches CatalogOption exactly, the same way
        // denominations and mint marks do it.
        isActive: true,
      }));
    });

    sendJson(res, 'GET /api/catalogs', catalogs, 'catalogue list');
  } catch (err) {
    sendDbError(res, 'GET /api/catalogs', err, 'Failed to retrieve catalogues', 'catalogue list');
  }
});

router.post('/catalogs', async (req: Request, res: Response) => {
  const { name } = req.body ?? {};

  // Whitespace is rejected as well as absence: a catalogue called " " would
  // sit in the picker as a blank line nobody can identify or ask for by name.
  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const trimmed = name.trim();

  try {
    logInfo(`Creating catalogue: ${trimmed}`);

    const created = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.catalogName, trimmed)
        // A new catalogue goes at the END of the picker. The seeded fifteen
        // hold 1..15 in the order the collection uses them, so defaulting to
        // the column's 0 would put the user's addition above Sear -- the
        // opposite of what "add one more" means. Computed in SQL rather than
        // sent by the client so two tabs cannot both claim the same slot.
        .query(`
          INSERT INTO Catalogs (Name, SortOrder, IsActive)
          SELECT @name, COALESCE(MAX(SortOrder), 0) + 1, 1 FROM Catalogs
          RETURNING CatalogId, SortOrder
        `);

      const row = result.recordset[0];
      if (!row) throw new Error('Catalogue INSERT returned no row from its OUTPUT clause');
      return row;
    });

    logInfo(`Catalogue created with ID: ${created['CatalogId']}`);
    res.status(201).json({
      catalogId: created['CatalogId'],
      name: trimmed,
      sortOrder: created['SortOrder'] ?? 0,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'POST /api/catalogs', err, 'Failed to create catalogue');
  }
});

router.put('/catalogs/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);
  const { name } = req.body ?? {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const trimmed = name.trim();

  try {
    logInfo(`Renaming catalogue ${id} to ${trimmed}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.catalogId, Number.parseInt(id, 10))
        .input('name', DB_BINDINGS.catalogName, trimmed)
        // Name only. SortOrder and IsActive are not editable from the
        // maintenance screen, and writing them here from an absent request
        // field would silently reactivate a removed catalogue or send it to
        // the top of the picker.
        .query('UPDATE Catalogs SET Name = @name WHERE CatalogId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Catalogue not found: ${id}`);
      res.status(404).json({ error: 'Catalogue not found' });
      return;
    }

    logInfo(`Catalogue ${id} renamed successfully`);
    res.json({
      catalogId: Number.parseInt(id, 10),
      name: trimmed,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'PUT /api/catalogs/:id', err, 'Failed to update catalogue');
  }
});

router.delete('/catalogs/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Soft-deleting catalogue ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.catalogId, Number.parseInt(id, 10))
        // *** SOFT. NEVER `DELETE FROM Catalogs`. ***
        // Coins point at this row through FK_Coins_Catalog, which has no
        // cascade: a hard delete fails on any catalogue in use, and the
        // "fix" of adding a cascade would delete the user's coins. This
        // leaves every attributed coin intact and still reading "Sear 6819",
        // and a mistaken removal is undone by setting IsActive back to 1.
        .query('UPDATE Catalogs SET IsActive = 0 WHERE CatalogId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Catalogue not found: ${id}`);
      res.status(404).json({ error: 'Catalogue not found' });
      return;
    }

    logInfo(`Catalogue ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/catalogs/:id', err, 'Failed to delete catalogue');
  }
});

export default router;
