/**
 * Data routes — Transactions, Spot Prices, Settings, and Frontend Logging.
 *
 * These handle the non-coin data: purchase/sale transactions, metal spot
 * prices (both database storage and live COMEX fetch), app settings, and
 * the endpoint that receives log messages from the Angular frontend.
 */

import { Router, Request, Response } from 'express';
import sql from 'mssql';
import crypto from 'crypto';
import { log, logInfo, logWarn, logError } from '../logger';
import { getPool, formatDate } from '../db';

const router = Router();

// ============================================================
// Transactions — /api/transactions
// ============================================================

router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const coinId = req.query['coinId'] as string | undefined;
    logInfo(`Fetching transactions${coinId ? ` for coin ${coinId}` : ''}`);

    let query = 'SELECT * FROM Transactions';
    const request = db.request();

    if (coinId) {
      query += ' WHERE CoinId = @coinId';
      request.input('coinId', sql.NVarChar(36), coinId);
    }

    query += ' ORDER BY TransactionDate DESC';
    const result = await request.query(query);

    const transactions = result.recordset.map((row) => ({
      id: row['TransactionId'],
      coinId: row['CoinId'],
      type: row['TransactionType'],
      date: formatDate(row['TransactionDate'] as Date),
      amount: row['Amount'],
      dealer: row['Dealer'] ?? '',
      notes: row['Notes'] ?? '',
    }));

    res.json(transactions);
  } catch (err) {
    logError('GET /api/transactions error', err);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

router.post('/transactions', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const body = req.body;
    const id = body.id || crypto.randomUUID();
    logInfo(`Creating transaction ${id} for coin ${body.coinId}`);

    if (!body.coinId || !body.type || !body.date) {
      res.status(400).json({ error: 'coinId, type, and date are required' });
      return;
    }

    await db.request()
      .input('id', sql.NVarChar(36), id)
      .input('coinId', sql.NVarChar(36), body.coinId)
      .input('type', sql.NVarChar(20), body.type)
      .input('date', sql.Date, body.date)
      .input('amount', sql.Decimal(12, 2), body.amount ?? 0)
      .input('dealer', sql.NVarChar(255), body.dealer ?? null)
      .input('notes', sql.NVarChar(sql.MAX), body.notes ?? null)
      .query(`
        INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount, Dealer, Notes)
        VALUES (@id, @coinId, @type, @date, @amount, @dealer, @notes)
      `);

    logInfo(`Transaction ${id} created successfully`);
    res.status(201).json({ id });
  } catch (err) {
    logError('POST /api/transactions error', err);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

router.delete('/transactions/:id', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { id } = req.params;
    logInfo(`Deleting transaction ${id}`);

    const result = await db.request()
      .input('id', sql.NVarChar(36), id)
      .query('DELETE FROM Transactions WHERE TransactionId = @id');

    if (result.rowsAffected[0] === 0) {
      logWarn(`Transaction not found: ${id}`);
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    logInfo(`Transaction ${id} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    logError('DELETE /api/transactions/:id error', err);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// ============================================================
// Spot Prices — /api/spot-prices
// ============================================================

router.get('/spot-prices/latest', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching latest spot prices from database');
    const db = await getPool();
    const result = await db.request()
      .query('SELECT TOP 1 * FROM SpotPrices ORDER BY FetchedAt DESC');

    if (result.recordset.length === 0) {
      res.json({ gold: 0, silver: 0, platinum: 0, copper: 0, source: null, fetchedAt: null });
      return;
    }

    const row = result.recordset[0];
    res.json({
      gold: row['Gold'],
      silver: row['Silver'],
      platinum: row['Platinum'],
      copper: row['Copper'],
      source: row['Source'],
      fetchedAt: row['FetchedAt'],
    });
  } catch (err) {
    logError('GET /api/spot-prices/latest error', err);
    res.status(500).json({ error: 'Failed to retrieve spot prices' });
  }
});

// Fetches live spot prices from metals.live (COMEX proxy)
router.get('/spot-prices/fetch', async (_req: Request, res: Response) => {
  logInfo('Fetching spot prices from metals.live...');
  try {
    const response = await fetch('https://api.metals.live/v1/spot');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    const prices = { gold: 0, silver: 0, platinum: 0, copper: 0 };
    for (const entry of data) {
      if (entry['gold'] !== undefined) prices.gold = entry['gold'];
      if (entry['silver'] !== undefined) prices.silver = entry['silver'];
      if (entry['platinum'] !== undefined) prices.platinum = entry['platinum'];
      if (entry['copper'] !== undefined) prices.copper = entry['copper'];
    }

    logInfo(`Spot prices fetched: Au=$${prices.gold} Ag=$${prices.silver}`);
    res.json({ prices, source: 'COMEX via metals.live', timestamp: new Date().toISOString() });
  } catch (err) {
    logError('Spot price fetch failed', err);
    res.json({
      prices: { gold: 0, silver: 0, platinum: 0, copper: 0 },
      source: 'COMEX via metals.live',
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

router.post('/spot-prices', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { gold, silver, platinum, copper, source } = req.body;
    logInfo(`Saving spot prices: Au=$${gold} Ag=$${silver}`);

    const result = await db.request()
      .input('gold', sql.Decimal(10, 2), gold ?? 0)
      .input('silver', sql.Decimal(10, 2), silver ?? 0)
      .input('platinum', sql.Decimal(10, 2), platinum ?? 0)
      .input('copper', sql.Decimal(10, 4), copper ?? 0)
      .input('source', sql.NVarChar(100), source ?? null)
      .query(`
        INSERT INTO SpotPrices (Gold, Silver, Platinum, Copper, Source)
        OUTPUT INSERTED.SpotPriceId, INSERTED.FetchedAt
        VALUES (@gold, @silver, @platinum, @copper, @source)
      `);

    res.status(201).json({
      id: result.recordset[0]['SpotPriceId'],
      fetchedAt: result.recordset[0]['FetchedAt'],
    });
  } catch (err) {
    logError('POST /api/spot-prices error', err);
    res.status(500).json({ error: 'Failed to save spot prices' });
  }
});

// ============================================================
// Settings — /api/settings
// ============================================================

router.get('/settings/:key', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { key } = req.params;
    logInfo(`Fetching setting: ${key}`);

    const result = await db.request()
      .input('key', sql.NVarChar(100), key)
      .query('SELECT SettingValue FROM AppSettings WHERE SettingKey = @key');

    if (result.recordset.length === 0) {
      logWarn(`Setting not found: ${key}`);
      res.status(404).json({ error: 'Setting not found' });
      return;
    }

    const raw = result.recordset[0]['SettingValue'] as string;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }

    res.json({ key, value });
  } catch (err) {
    logError('GET /api/settings/:key error', err);
    res.status(500).json({ error: 'Failed to retrieve setting' });
  }
});

router.put('/settings/:key', async (req: Request, res: Response) => {
  try {
    const db = await getPool();
    const { key } = req.params;
    const { value } = req.body;
    logInfo(`Saving setting: ${key}`);

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    await db.request()
      .input('key', sql.NVarChar(100), key)
      .input('value', sql.NVarChar(sql.MAX), serialized)
      .query(`
        MERGE AppSettings AS target
        USING (SELECT @key AS SettingKey) AS source
        ON target.SettingKey = source.SettingKey
        WHEN MATCHED THEN UPDATE SET SettingValue = @value
        WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@key, @value);
      `);

    res.json({ key, value });
  } catch (err) {
    logError('PUT /api/settings/:key error', err);
    res.status(500).json({ error: 'Failed to save setting' });
  }
});

// ============================================================
// Frontend Logging — POST /api/log
// ============================================================

router.post('/log', (req: Request, res: Response) => {
  const { level, message, details, source } = req.body;
  log(level ?? 'INFO', `[${source ?? 'frontend'}] ${message}`, details);
  res.status(204).send();
});

export default router;
