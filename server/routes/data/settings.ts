/**
 * The AppSettings key/value store for UI preferences. Mounted at /api:
 *
 *   GET /settings/:key  { key, value }, 404 if never saved
 *   PUT /settings/:key  upsert, always 200
 *
 * Non-string values are stored as JSON; reads try JSON.parse and fall back to
 * the raw text (so "dark" comes back as "dark").
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
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

    sendJson(res, 'GET /api/settings/:key', { key, value }, 'setting');
  } catch (err) {
    sendDbError(res, 'GET /api/settings/:key', err, 'Failed to retrieve setting', 'setting');
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
        // Upsert; `excluded` is the row the INSERT tried to add.
        .query(`
          INSERT INTO AppSettings (SettingKey, SettingValue)
          VALUES (@key, @value)
          ON CONFLICT (SettingKey) DO UPDATE SET SettingValue = excluded.SettingValue
        `);
    });

    res.json({ key, value });
  } catch (err) {
    sendDbError(res, 'PUT /api/settings/:key', err, 'Failed to save setting');
  }
});

export default router;
