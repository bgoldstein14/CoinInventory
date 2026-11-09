/**
 * routes/lookups/issuers.ts — the Issuers reference table.
 *
 * Who struck the coin. "Issuer" rather than "Country" because the Roman
 * Empire, the Papal States and the German states are not countries, and
 * ancients are explicitly in scope.
 *
 * Mounted (via routes/lookups/index.ts) at /api:
 *
 *   GET    /issuers      -> active issuers, with their denomination and coin
 *                           counts, in picker order
 *   POST   /issuers      -> create one (returns the new IssuerId)
 *   PUT    /issuers/:id  -> edit one IN PLACE, keeping its id
 *   DELETE /issuers/:id  -> soft-delete (IsActive = 0), refused while
 *                           denominations still point at it
 *
 * The seed (migration 013) covers 61 issuers, chosen for accuracy over
 * coverage: a user adding a missing denomination is a normal action, while a
 * user trusting a wrong one that shipped with the app is a silent error. That
 * trade only works if adding the missing one is possible, which is what these
 * routes provide.
 *
 * FOUR THINGS HERE DIFFER FROM THE OTHER LOOKUP ROUTES
 *
 * 1. GET CARRIES COUNTS, so the maintenance screen can say "23 denominations,
 *    7 coins" beside an issuer BEFORE the user presses Remove. Both joins are
 *    LEFT joins, which is the whole trick: an issuer with no denominations —
 *    one added ten seconds ago, precisely the row the user is looking for —
 *    must still come back, with two zeroes. `COUNT(DISTINCT d.DenominationId)`
 *    is needed because the second join multiplies a denomination row once per
 *    coin using it.
 *
 * 2. POST VALIDATES BEFORE IT TOUCHES THE DATABASE. Three of the five columns
 *    can be silently mangled rather than rejected:
 *      * Name has UQ_Issuers_Name, so a duplicate is a 2627 and a 500 with
 *        SQL Server's own wording in it. Worse, the seed script matches
 *        issuers BY NAME, so a second 'Mexico' makes its join multiply rows
 *        instead of failing.
 *      * IsoCode is CHAR(2), which truncates and pads without complaint.
 *      * Kind is NVARCHAR(20) with no CHECK constraint, so 'imaginary' is
 *        stored happily and then cannot be grouped, filtered or rendered.
 *
 * 3. PUT EDITS IN PLACE. Denominations reference an issuer BY ID, so
 *    remove-and-re-add — all the text lookups offer — would orphan every
 *    denomination filed under it. Same argument as catalogs.ts.
 *
 * 4. DELETE REFUSES RATHER THAN WARNS, and it is the only route here that
 *    does. See the block above the handler.
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

/** The three values Issuers.Kind is allowed to hold. */
const ISSUER_KINDS = new Set(['modern', 'historical', 'ancient']);

/** Issuers.Name NVARCHAR(100). */
const NAME_MAX_LENGTH = 100;

/**
 * The rows a client sent, checked and normalised, or the reason they are not
 * usable. Shared by POST and PUT so the two cannot drift about what a legal
 * issuer looks like — which is the usual way a "you can create it but not
 * edit it to the same value" bug appears.
 */
interface ValidIssuerBody {
  name: string;
  isoCode: string | null;
  kind: string;
  validFrom: number | null;
  validTo: number | null;
}

function readIssuerBody(body: unknown): { ok: true; value: ValidIssuerBody } | { ok: false; error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be ${NAME_MAX_LENGTH} characters or fewer` };
  }

  const kind = typeof raw['kind'] === 'string' ? raw['kind'].trim().toLowerCase() : '';
  if (!ISSUER_KINDS.has(kind)) {
    return { ok: false, error: "kind must be one of 'modern', 'historical' or 'ancient'" };
  }

  // Absent, null and '' all mean "this issuer has no ISO code", which is the
  // normal state for every ancient and most historical states. Anything
  // present must be exactly two letters; see the binding's comment for what
  // CHAR(2) does to the alternatives.
  const isoRaw = raw['isoCode'];
  let isoCode: string | null = null;
  if (typeof isoRaw === 'string' && isoRaw.trim().length > 0) {
    const trimmed = isoRaw.trim();
    if (!/^[A-Za-z]{2}$/.test(trimmed)) {
      return { ok: false, error: 'isoCode must be exactly two letters, or omitted' };
    }
    isoCode = trimmed.toUpperCase();
  }

  const years: Record<string, number | null> = {};
  for (const field of ['validFrom', 'validTo'] as const) {
    const value = raw[field];
    if (value === undefined || value === null || value === '') {
      years[field] = null;
      continue;
    }
    const year = Number(value);
    // Integer, and negative is legal: -509 is the Roman Republic.
    if (!Number.isInteger(year)) return { ok: false, error: `${field} must be a whole year` };
    years[field] = year;
  }

  const validFrom = years['validFrom'] ?? null;
  const validTo = years['validTo'] ?? null;
  if (validFrom !== null && validTo !== null && validTo < validFrom) {
    return { ok: false, error: 'validTo must not be before validFrom' };
  }

  return { ok: true, value: { name, isoCode, kind, validFrom, validTo } };
}

/**
 * Is some OTHER issuer already called this?
 *
 * `excludeId` is what lets PUT leave the name alone: without it, saving an
 * issuer whose name you did not change would fail against itself, which is
 * a maddening bug to meet when all you wanted was to add an end date.
 *
 * Compared with LOWER(LTRIM(RTRIM(...))) rather than by exact equality,
 * because 'mexico ' and 'Mexico' are the same issuer to a human and
 * UQ_Issuers_Name would let both in.
 */
async function findNameClash(name: string, excludeId: number | null): Promise<string | null> {
  return withDb(async (db) => {
    const result = await db.request()
      .input('name', DB_BINDINGS.issuerName, name)
      .input('id', DB_BINDINGS.issuerId, excludeId ?? 0)
      .query(`
        SELECT TOP 1 Name FROM Issuers
        WHERE LOWER(LTRIM(RTRIM(Name))) = LOWER(LTRIM(RTRIM(@name)))
          AND IssuerId <> @id
      `);

    const row = result.recordset[0];
    return row ? String(row['Name']) : null;
  });
}

router.get('/issuers', async (_req: Request, res: Response) => {
  try {
    logInfo('Fetching active issuers');

    const issuers = await withDb(async (db) => {
      const result = await db.request().query(`
        SELECT
            i.IssuerId,
            i.Name,
            i.IsoCode,
            i.Kind,
            i.ValidFrom,
            i.ValidTo,
            i.SortOrder,
            COUNT(DISTINCT d.DenominationId) AS DenominationCount,
            COUNT(c.CoinId)                  AS CoinCount
        FROM Issuers i
        LEFT JOIN Denominations d ON d.IssuerId = i.IssuerId AND d.IsActive = 1
        LEFT JOIN Coins c        ON c.DenominationId = d.DenominationId
        WHERE i.IsActive = 1
        GROUP BY i.IssuerId, i.Name, i.IsoCode, i.Kind, i.ValidFrom, i.ValidTo, i.SortOrder
        ORDER BY i.SortOrder, i.Name
      `);

      return result.recordset.map((row: Record<string, unknown>) => ({
        issuerId: row['IssuerId'],
        name: row['Name'],
        // CHAR(2) comes back space-padded when anything ever wrote a short
        // value, so it is trimmed on the way out. Null stays null rather
        // than becoming '': a blank two-letter box reads as missing data,
        // and for an ancient there is no data to miss.
        isoCode: row['IsoCode'] === null || row['IsoCode'] === undefined
          ? null
          : String(row['IsoCode']).trim() || null,
        kind: row['Kind'],
        validFrom: row['ValidFrom'] ?? null,
        validTo: row['ValidTo'] ?? null,
        sortOrder: row['SortOrder'] ?? 0,
        denominationCount: Number(row['DenominationCount'] ?? 0),
        coinCount: Number(row['CoinCount'] ?? 0),
        isActive: true,
      }));
    });

    sendJson(res, 'GET /api/issuers', issuers, 'issuer list');
  } catch (err) {
    sendDbError(res, 'GET /api/issuers', err, 'Failed to retrieve issuers', 'issuer list');
  }
});

router.post('/issuers', async (req: Request, res: Response) => {
  const parsed = readIssuerBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const issuer = parsed.value;

  try {
    const clash = await findNameClash(issuer.name, null);
    if (clash) {
      logWarn(`Refusing duplicate issuer name: ${issuer.name}`);
      res.status(409).json({ error: `"${clash}" is already an issuer` });
      return;
    }

    logInfo(`Creating issuer: ${issuer.name} (${issuer.kind})`);

    const created = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, issuer.kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        // SortOrder computed in SQL, for the same reason catalogues do it:
        // two tabs cannot both claim the same slot, and a user's addition
        // belongs AFTER the seeded 61 rather than jumping above them.
        .query(`
          INSERT INTO Issuers (Name, IsoCode, Kind, ValidFrom, ValidTo, SortOrder, IsActive)
          OUTPUT INSERTED.IssuerId, INSERTED.SortOrder
          SELECT @name, @isoCode, @kind, @validFrom, @validTo, COALESCE(MAX(SortOrder), 0) + 10, 1
          FROM Issuers
        `);

      const row = result.recordset[0];
      if (!row) throw new Error('Issuer INSERT returned no row from its OUTPUT clause');
      return row;
    });

    logInfo(`Issuer created with ID: ${created['IssuerId']}`);
    res.status(201).json({
      issuerId: created['IssuerId'],
      name: issuer.name,
      isoCode: issuer.isoCode,
      kind: issuer.kind,
      validFrom: issuer.validFrom,
      validTo: issuer.validTo,
      sortOrder: created['SortOrder'] ?? 0,
      // A brand-new issuer has neither, by definition. Returned so the
      // client can push the row straight into its list without a reload and
      // without a template reading `undefined` where a number belongs.
      denominationCount: 0,
      coinCount: 0,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'POST /api/issuers', err, 'Failed to create issuer');
  }
});

router.put('/issuers/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(toSingleValue(req.params['id']), 10);
  const parsed = readIssuerBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const issuer = parsed.value;

  try {
    const clash = await findNameClash(issuer.name, id);
    if (clash) {
      res.status(409).json({ error: `"${clash}" is already an issuer` });
      return;
    }

    logInfo(`Updating issuer ${id}`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.issuerId, id)
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, issuer.kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        .query(`
          UPDATE Issuers
          SET Name = @name, IsoCode = @isoCode, Kind = @kind,
              ValidFrom = @validFrom, ValidTo = @validTo
          WHERE IssuerId = @id
        `);
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Issuer not found: ${id}`);
      res.status(404).json({ error: 'Issuer not found' });
      return;
    }

    res.json({
      issuerId: id,
      name: issuer.name,
      isoCode: issuer.isoCode,
      kind: issuer.kind,
      validFrom: issuer.validFrom,
      validTo: issuer.validTo,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'PUT /api/issuers/:id', err, 'Failed to update issuer');
  }
});

/**
 * Soft-delete an issuer — REFUSED while denominations still point at it.
 *
 * *** THE ONLY REFUSAL ON THIS SCREEN, AND THE REASON IS SPECIFIC. ***
 * Everywhere else the screen counts, warns and does as it is told — a
 * warned-about deletion must go through. This one is different because it is
 * the one case the database cannot catch and the user cannot undo in one
 * step:
 *
 *   * The delete is SOFT (IsActive = 0), so FK_Denominations_Issuer never
 *     fires — it only guards an actual row deletion.
 *   * The denominations keep their IssuerId, pointing at a row GET no longer
 *     returns. The maintenance screen files exactly that case under "No
 *     issuer yet" (see denomination-grouping.ts, which deliberately does not
 *     drop them), so all of that issuer's denominations reappear at the
 *     bottom of a list of over a thousand with nothing saying why.
 *   * Reactivating the issuer afterwards puts them back, but only if
 *     somebody works out that is what happened.
 *
 * Making the user move or remove the denominations first keeps every step
 * explicit and separately reversible. The 409 carries the count so the
 * screen can say what to do rather than just "no".
 */
router.delete('/issuers/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(toSingleValue(req.params['id']), 10);

  try {
    const denominationCount = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.issuerId, id)
        .query('SELECT COUNT(*) AS DenominationCount FROM Denominations WHERE IssuerId = @id AND IsActive = 1');
      return Number(result.recordset[0]?.['DenominationCount'] ?? 0);
    });

    if (denominationCount > 0) {
      logWarn(`Refusing to remove issuer ${id}: ${denominationCount} denominations still filed under it`);
      res.status(409).json({
        error:
          `${denominationCount} denomination${denominationCount === 1 ? '' : 's'} ` +
          'are still filed under this issuer. Move or remove them first.',
        denominationCount,
      });
      return;
    }

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.issuerId, id)
        .query('UPDATE Issuers SET IsActive = 0 WHERE IssuerId = @id');
      return result.rowsAffected[0];
    });

    if (rowsAffected === 0) {
      logWarn(`Issuer not found: ${id}`);
      res.status(404).json({ error: 'Issuer not found' });
      return;
    }

    logInfo(`Issuer ${id} soft-deleted successfully`);
    res.status(204).send();
  } catch (err) {
    sendDbError(res, 'DELETE /api/issuers/:id', err, 'Failed to delete issuer');
  }
});

export default router;
