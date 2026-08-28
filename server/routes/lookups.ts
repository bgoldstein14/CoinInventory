/**
 * Lookup table routes — Categories, Coin Sets, Denominations, and Mint Marks.
 *
 * These are all simple reference tables with similar CRUD patterns.
 * Categories and Coin Sets are plain name lists.
 * Denominations and Mint Marks support soft-delete (IsActive flag).
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import { logInfo, logWarn, logError } from '../logger';
import { getPool } from '../db';

const router = Router();

// ============================================================
// Categories — /api/categories
// ============================================================

router.get('/categories', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching categories');
    const db = await getPool();
    const result = await db.request().query('SELECT CategoryName FROM Categories ORDER BY CategoryName');
    res.json(result.recordset.map((r) => r['CategoryName'] as string));
  } catch (err) {
    logError('GET /api/categories error', err);
    res.status(500).json({ error: 'Failed to retrieve categories' });
  }
});

router.post('/categories', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.body;
    logInfo(`Adding category: ${name}`);

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    await db.request()
      .input('name', sql.NVarChar(100), name.trim())
      .query(`
        IF NOT EXISTS (SELECT 1 FROM Categories WHERE CategoryName = @name)
          INSERT INTO Categories (CategoryName) VALUES (@name)
      `);

    res.status(201).json({ name: name.trim() });
  } catch (err) {
    logError('POST /api/categories error', err);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

router.delete('/categories/:name', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.params;
    logInfo(`Deleting category: ${name}`);

    const result = await db.request()
      .input('name', sql.NVarChar(100), name)
      .query('DELETE FROM Categories WHERE CategoryName = @name');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Category not found: ${name}`);
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    logInfo(`Category ${name} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/categories/:name error', err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ============================================================
// Coin Sets — /api/coin-sets
// ============================================================

router.get('/coin-sets', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching coin sets');
    const db = await getPool();
    const result = await db.request().query('SELECT SetName FROM CoinSets ORDER BY SetName');
    res.json(result.recordset.map((r) => r['SetName'] as string));
  } catch (err) {
    logError('GET /api/coin-sets error', err);
    res.status(500).json({ error: 'Failed to retrieve coin sets' });
  }
});

router.post('/coin-sets', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.body;
    logInfo(`Adding coin set: ${name}`);

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    await db.request()
      .input('name', sql.NVarChar(255), name.trim())
      .query(`
        IF NOT EXISTS (SELECT 1 FROM CoinSets WHERE SetName = @name)
          INSERT INTO CoinSets (SetName) VALUES (@name)
      `);

    res.status(201).json({ name: name.trim() });
  } catch (err) {
    logError('POST /api/coin-sets error', err);
    res.status(500).json({ error: 'Failed to add coin set' });
  }
});

router.delete('/coin-sets/:name', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { name } = req.params;
    logInfo(`Deleting coin set: ${name}`);

    const result = await db.request()
      .input('name', sql.NVarChar(255), name)
      .query('DELETE FROM CoinSets WHERE SetName = @name');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Coin set not found: ${name}`);
      res.status(404).json({ error: 'Coin set not found' });
      return;
    }

    logInfo(`Coin set ${name} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/coin-sets/:name error', err);
    res.status(500).json({ error: 'Failed to delete coin set' });
  }
});

// ============================================================
// Denominations — /api/denominations (soft-delete via IsActive)
// ============================================================

router.get('/denominations', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active denominations');
    const db = await getPool();
    const result = await db.request()
      .query('SELECT DenominationId, Label, Country, SortOrder FROM Denominations WHERE IsActive = 1 ORDER BY Country, SortOrder');

    const denominations = result.recordset.map((row) => ({
      id: row['DenominationId'],
      label: row['Label'],
      country: row['Country'],
      sortOrder: row['SortOrder'],
    }));

    res.json(denominations);
  } catch (err) {
    logError('GET /api/denominations error', err);
    res.status(500).json({ error: 'Failed to retrieve denominations' });
  }
});

router.post('/denominations', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { label, country, sortOrder } = req.body;
    logInfo(`Creating denomination: ${label} (${country})`);

    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    const result = await db.request()
      .input('label', sql.NVarChar(100), label.trim())
      .input('country', sql.NVarChar(100), country ?? null)
      .input('sortOrder', sql.Int, sortOrder ?? 0)
      .query(`
        INSERT INTO Denominations (Label, Country, SortOrder, IsActive)
        OUTPUT INSERTED.DenominationId
        VALUES (@label, @country, @sortOrder, 1)
      `);

    const id = result.recordset[0]['DenominationId'];
    logInfo(`Denomination created with ID: ${id}`);
    res.status(201).json({ id, label: label.trim(), country, sortOrder: sortOrder ?? 0 });
  } catch (err) {
    logError('POST /api/denominations error', err);
    res.status(500).json({ error: 'Failed to create denomination' });
  }
});

router.put('/denominations/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    const { label, country, sortOrder } = req.body;
    logInfo(`Updating denomination ${id}`);

    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    const result = await db.request()
      .input('id', sql.Int, parseInt(id, 10))
      .input('label', sql.NVarChar(100), label.trim())
      .input('country', sql.NVarChar(100), country ?? null)
      .input('sortOrder', sql.Int, sortOrder ?? 0)
      .query(`
        UPDATE Denominations
        SET Label = @label, Country = @country, SortOrder = @sortOrder
        WHERE DenominationId = @id
      `);

    if (result.rowsAffected[0] === 0) {
      logWarn(`Denomination not found: ${id}`);
      res.status(404).json({ error: 'Denomination not found' });
      return;
    }

    logInfo(`Denomination ${id} updated successfully`);
    res.json({ id, label: label.trim(), country, sortOrder: sortOrder ?? 0 });
  } catch (err) {
    logError('PUT /api/denominations/:id error', err);
    res.status(500).json({ error: 'Failed to update denomination' });
  }
});

router.delete('/denominations/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Soft-deleting denomination ${id}`);

    const result = await db.request()
      .input('id', sql.Int, parseInt(id, 10))
      .query('UPDATE Denominations SET IsActive = 0 WHERE DenominationId = @id');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Denomination not found: ${id}`);
      res.status(404).json({ error: 'Denomination not found' });
      return;
    }

    logInfo(`Denomination ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/denominations/:id error', err);
    res.status(500).json({ error: 'Failed to delete denomination' });
  }
});

// ============================================================
// Mint Marks — /api/mintmarks (soft-delete via IsActive)
// ============================================================

router.get('/mintmarks', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active mint marks');
    const db = await getPool();
    const result = await db.request()
      .query('SELECT MintMarkId, Label, Description FROM MintMarks WHERE IsActive = 1 ORDER BY Label');

    const mintmarks = result.recordset.map((row) => ({
      id: row['MintMarkId'],
      label: row['Label'],
      description: row['Description'] ?? '',
    }));

    res.json(mintmarks);
  } catch (err) {
    logError('GET /api/mintmarks error', err);
    res.status(500).json({ error: 'Failed to retrieve mint marks' });
  }
});

router.post('/mintmarks', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { label, description } = req.body;
    logInfo(`Creating mint mark: ${label}`);

    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    const result = await db.request()
      .input('label', sql.NVarChar(10), label.trim())
      .input('description', sql.NVarChar(255), description ?? null)
      .query(`
        INSERT INTO MintMarks (Label, Description, IsActive)
        OUTPUT INSERTED.MintMarkId
        VALUES (@label, @description, 1)
      `);

    const id = result.recordset[0]['MintMarkId'];
    logInfo(`Mint mark created with ID: ${id}`);
    res.status(201).json({ id, label: label.trim(), description });
  } catch (err) {
    logError('POST /api/mintmarks error', err);
    res.status(500).json({ error: 'Failed to create mint mark' });
  }
});

router.put('/mintmarks/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    const { label, description } = req.body;
    logInfo(`Updating mint mark ${id}`);

    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'label is required' });
      return;
    }

    const result = await db.request()
      .input('id', sql.Int, parseInt(id, 10))
      .input('label', sql.NVarChar(10), label.trim())
      .input('description', sql.NVarChar(255), description ?? null)
      .query(`
        UPDATE MintMarks
        SET Label = @label, Description = @description
        WHERE MintMarkId = @id
      `);

    if (result.rowsAffected[0] === 0) {
      logWarn(`Mint mark not found: ${id}`);
      res.status(404).json({ error: 'Mint mark not found' });
      return;
    }

    logInfo(`Mint mark ${id} updated successfully`);
    res.json({ id, label: label.trim(), description });
  } catch (err) {
    logError('PUT /api/mintmarks/:id error', err);
    res.status(500).json({ error: 'Failed to update mint mark' });
  }
});

router.delete('/mintmarks/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Soft-deleting mint mark ${id}`);

    const result = await db.request()
      .input('id', sql.Int, parseInt(id, 10))
      .query('UPDATE MintMarks SET IsActive = 0 WHERE MintMarkId = @id');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Mint mark not found: ${id}`);
      res.status(404).json({ error: 'Mint mark not found' });
      return;
    }

    logInfo(`Mint mark ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/mintmarks/:id error', err);
    res.status(500).json({ error: 'Failed to delete mint mark' });
  }
});

export default router;
