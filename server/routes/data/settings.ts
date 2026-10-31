/**
 * routes/data/settings.ts — the AppSettings key/value store.
 *
 * This is where the Angular app persists UI preferences (which table columns
 * are visible, the chosen theme, and so on). Mounted (via routes/data/index.ts)
 * at /api:
 *
 *   GET /settings/:key  -> { key, value }, 404 if the key was never saved
 *   PUT /settings/:key  -> upsert (MERGE), always 200
 *
 * SettingValue is NVARCHAR(MAX) text. Anything that is not already a string is
 * stored as JSON on the way in, and we try to JSON.parse on the way out —
 * falling back to the raw text if it does not parse, so a plain value like
 * "dark" still comes back as "dark" rather than blowing up.
 *
 * Database calls go through `withDb()`; parameter types come from DB_BINDINGS.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError } from '../db-error-response';
import { toSingleValue } from '../param-utils';

const router = Router();

router.get('/settings/:key', async (req: Request, res: Response) => {
  const key = toSingleValue(req.params['key']);

  try {
    logInfo(`Fetching setting: ${key}`);

    const raw = await withDb(async (db) => {
      const result = await db.request()
        .input('key', DB_BINDINGS.settingKey, key)
        .query('SELECT SettingValue FROM AppSettings WHERE SettingKey = @key');

      if (result.recordset.length === 0) return null;
      return result.recordset[0]['SettingValue'] as string;
    });

    if (raw === null) {
      logWarn(`Setting not found: ${key}`);
      res.status(404).json({ error: 'Setting not found' });
      return;
    }

    let value: unknown;
    try { value = JSON.parse(raw); } catch { value = raw; }

    res.json({ key, value });
  } catch (err) {
    sendDbError(res, 'GET /api/settings/:key', err, 'Failed to retrieve setting');
  }
});

router.put('/settings/:key', async (req: Request, res: Response) => {
  const key = toSingleValue(req.params['key']);
  const { value } = req.body ?? {};

  try {
    logInfo(`Saving setting: ${key}`);

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    await withDb(async (db) => {
      await db.request()
        .input('key', DB_BINDINGS.settingKey, key)
        .input('value', DB_BINDINGS.settingValue, serialized)
        .query(`
          MERGE AppSettings AS target
          USING (SELECT @key AS SettingKey) AS source
          ON target.SettingKey = source.SettingKey
          WHEN MATCHED THEN UPDATE SET SettingValue = @value
          WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@key, @value);
        `);
    });

    res.json({ key, value });
  } catch (err) {
    sendDbError(res, 'PUT /api/settings/:key', err, 'Failed to save setting');
  }
});

export default router;
