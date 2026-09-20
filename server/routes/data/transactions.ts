/**
 * routes/data/transactions.ts — purchase / sale history.
 *
 * A transaction records money changing hands for a coin. Mounted (via
 * routes/data/index.ts) at /api:
 *
 *   GET    /transactions          -> all of them, newest first;
 *                                    optional ?coinId= filter
 *   POST   /transactions          -> record one
 *   DELETE /transactions/:id      -> remove one
 *
 * Transactions.TransactionDate is NVARCHAR(30) in the schema, NOT a DATE
 * column, so dates go in through the shared `normalizeTextDate()` helper and
 * come back out through `formatDate()`. Doing it any other way produces a
 * locale-dependent string that will not round-trip.
 *
 * Every database call goes through `withDb()` so that a dropped connection is
 * retried once and an ordinary query error never tears down the shared pool.
 * Parameter types come from DB_BINDINGS so they stay in sync with
 * setup-database.sql.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { logInfo, logWarn } from '../../logger';
import { withDb, formatDate, normalizeTextDate, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const coinIdValue = req.query['coinId'];
    const coinId = typeof coinIdValue === 'string'
      ? coinIdValue
      : Array.isArray(coinIdValue) ? String(coinIdValue[0]) : undefined;
    logInfo(`Fetching transactions${coinId ? ` for coin ${coinId}` : ''}`);

    const transactions = await withDb(async (db) => {
      let query = 'SELECT * FROM Transactions';
      const request = db.request();

      if (coinId) {
        query += ' WHERE CoinId = @coinId';
        request.input('coinId', DB_BINDINGS.coinId, coinId);
      }

      query += ' ORDER BY TransactionDate DESC';
      const result = await request.query(query);

      return result.recordset.map((row: Record<string, unknown>) => ({
        id: row['TransactionId'],
        coinId: row['CoinId'],
        type: row['TransactionType'],
        date: formatDate(row['TransactionDate'] as Date | string),
        amount: row['Amount'],
        dealer: row['Dealer'] ?? '',
        notes: row['Notes'] ?? '',
      }));
    });

    res.json(transactions);
  } catch (err) {
    sendDbError(res, 'GET /api/transactions', err, 'Failed to retrieve transactions');
  }
});

router.post('/transactions', async (req: Request, res: Response) => {
  const body = req.body ?? {};

  // Validate up front so a bad request never reaches the database.
  if (!body.coinId || !body.type || !body.date) {
    res.status(400).json({ error: 'coinId, type, and date are required' });
    return;
  }

  const id = body.id || crypto.randomUUID();

  try {
    logInfo(`Creating transaction ${id} for coin ${body.coinId}`);

    await withDb(async (db) => {
      await db.request()
        .input('id', DB_BINDINGS.transactionId, id)
        .input('coinId', DB_BINDINGS.coinId, body.coinId)
        .input('type', DB_BINDINGS.transactionType, body.type)
        .input('date', DB_BINDINGS.transactionDate, normalizeTextDate(body.date))
        .input('amount', DB_BINDINGS.transactionAmount, body.amount ?? 0)
        .input('dealer', DB_BINDINGS.transactionDealer, body.dealer ?? null)
        .input('notes', DB_BINDINGS.transactionNotes, body.notes ?? null)
        .query(`
          INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount, Dealer, Notes)
          VALUES (@id, @coinId, @type, @date, @amount, @dealer, @notes)
        `);
    });

    logInfo(`Transaction ${id} created successfully`);
    res.status(201).json({ id });
  } catch (err) {
    sendDbError(res, 'POST /api/transactions', err, 'Failed to create transaction');
  }
});

router.delete('/transactions/:id', async (req: Request, res: Response) => {
  const id = toSingleValue(req.params['id']);

  try {
    logInfo(`Deleting transaction ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.transactionId, id)
        .query('DELETE FROM Transactions WHERE TransactionId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Transaction not found: ${id}`);
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    logInfo(`Transaction ${id} deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/transactions/:id', err, 'Failed to delete transaction');
  }
});

export default router;
