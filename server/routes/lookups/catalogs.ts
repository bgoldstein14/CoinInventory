/**
 * The Catalogs reference table (Sear, RIC, Hendin, Krause, ...). A coin's
 * references (CoinCatalogRefs) store a catalogue id plus a free-text number,
 * read together as "Sear 6819".
 * Mounted at /api:
 *
 *   GET    /catalogs      all catalogues with isActive, in picker order
 *   POST   /catalogs      create one (returns the new CatalogId)
 *   PUT    /catalogs/:id  rename in place (coins reference it by id)
 *   DELETE /catalogs/:id  soft-delete (IsActive = 0)
 *
 * Mirrors mint-marks.ts. Catalogs.Name is NVARCHAR(60), matching
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
    logInfo('Fetching catalogues');

    const catalogs = await withDb(async (db) => {
      const result = await db.request()
        // SortOrder, not Name: the seed orders catalogues by how this
        // collection uses them (Sear first). Id breaks ties.
        .query(
          'SELECT CatalogId, Name, SortOrder, IsActive FROM Catalogs ' +
            'ORDER BY SortOrder, CatalogId'
        );

      return result.recordset.map((row: Record<string, unknown>) => ({
        catalogId: row['CatalogId'],
        name: row['Name'],
        sortOrder: row['SortOrder'] ?? 0,
        // Removed catalogues are included so coins that use them keep their name.
        isActive: Number(row['IsActive'] ?? 1) === 1,
      }));
    });

    sendJson(res, 'GET /api/catalogs', catalogs, 'catalogue list');
  } catch (err) {
    sendDbError(res, 'GET /api/catalogs', err, 'Failed to retrieve catalogues', 'catalogue list');
  }
});

router.post('/catalogs', async (req: Request, res: Response) => {
  const { name } = req.body ?? {};

  // Whitespace-only names are rejected too.
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
        // New catalogues go after the seeded ones. Computed in SQL so two
        // tabs can't claim the same slot.
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
        // Name only, so an absent field can't reactivate or reorder a catalogue.
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
        // Soft delete only. FK_Coins_Catalog has no cascade, so a hard delete
        // fails for catalogues in use (and a cascade would delete coins).
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
