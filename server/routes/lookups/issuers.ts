/**
 * The Issuers reference table ("issuer" rather than "country", since the
 * Roman Empire or the Papal States aren't countries). Mounted at /api:
 *
 *   GET    /issuers      active issuers with denomination and coin counts, A-Z
 *   POST   /issuers      create one (201), or revive a soft-deleted row with
 *                        the same name (200, same id, its denominations too)
 *   PUT    /issuers/:id  edit in place, keeping the id
 *   DELETE /issuers/:id  soft-delete, cascading to its denominations and
 *                        unlinking their coins, in one transaction
 *
 * Kind is derived from the year span (issuer-kind.ts). A supplied `kind` must
 * still be valid, but is only used when the issuer has no years. PUT falls
 * back to the stored Kind so undated issuers (e.g. British Colonial) keep it.
 * PUT edits in place because denominations reference issuers by id.
 */

import { Router, Request, Response } from 'express';
import { logInfo, logWarn } from '../../logger';
import { withDb, DB_BINDINGS, DbRequest, DbTransaction } from '../../db';
import { sendDbError, sendJson } from '../db-error-response';
import { toSingleValue } from '../param-utils';
import { safeRollback } from '../coins/write-helpers';
import { IssuerKind, isIssuerKind, resolveIssuerKind } from './issuer-kind';

const router = Router();

/** Issuers.Name NVARCHAR(100). */
const NAME_MAX_LENGTH = 100;

/**
 * A client body, validated and normalized, or the reason it isn't usable.
 * Shared by POST and PUT so they agree on what a legal issuer is.
 */
interface ValidIssuerBody {
  name: string;
  isoCode: string | null;
  /** A `kind` the client sent; only used when the year span is empty. */
  suppliedKind: IssuerKind | null;
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

  // Usually absent (the form derives kind). An invalid value is still a 400,
  // since the column has no CHECK constraint.
  const rawKind = raw['kind'];
  let suppliedKind: IssuerKind | null = null;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    const text = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : rawKind;
    if (!isIssuerKind(text)) {
      return { ok: false, error: "kind must be one of 'modern', 'historical' or 'ancient'" };
    }
    suppliedKind = text;
  }

  // Absent, null and '' mean "no ISO code" (normal for ancients). Otherwise
  // it must be exactly two letters.
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
    // Negative years are valid (-509 = Roman Republic).
    if (!Number.isInteger(year)) return { ok: false, error: `${field} must be a whole year` };
    years[field] = year;
  }

  const validFrom = years['validFrom'] ?? null;
  const validTo = years['validTo'] ?? null;
  if (validFrom !== null && validTo !== null && validTo < validFrom) {
    return { ok: false, error: 'validTo must not be before validFrom' };
  }

  return { ok: true, value: { name, isoCode, suppliedKind, validFrom, validTo } };
}

/** The row's current Kind, or null if there is no such row. PUT uses it as the fallback for undated issuers. */
async function storedKindOf(id: number): Promise<IssuerKind | null> {
  return withDb(async (db) => {
    const result = await db.request()
      .input('id', DB_BINDINGS.issuerId, id)
      .query('SELECT Kind FROM Issuers WHERE IssuerId = @id');

    const raw = result.recordset[0]?.['Kind'];
    return isIssuerKind(raw) ? raw : null;
  });
}

/** An issuer row that already owns the name somebody is trying to use. */
interface IssuerNameMatch {
  issuerId: number;
  name: string;
  /** False means the row is soft-deleted. */
  isActive: boolean;
}

/**
 * Which other issuer row already owns this name, active or not.
 *
 * Must not filter on IsActive: a soft-deleted row still holds the name, and
 * hiding it would let the INSERT hit UQ_Issuers_Name (a 500). The caller
 * decides: an active match is a 409, an inactive one is revived.
 *
 * `excludeId` lets PUT keep its own name. The comparison trims and lowercases,
 * which is wider than the unique constraint (case only), so more than one row
 * can match; ORDER BY IsActive DESC makes an active match win.
 */
async function findNameMatch(name: string, excludeId: number | null): Promise<IssuerNameMatch | null> {
  return withDb(async (db) => {
    const result = await db.request()
      .input('name', DB_BINDINGS.issuerName, name)
      .input('id', DB_BINDINGS.issuerId, excludeId ?? 0)
      .query(`
        SELECT IssuerId, Name, IsActive FROM Issuers
        WHERE LOWER(LTRIM(RTRIM(Name))) = LOWER(LTRIM(RTRIM(@name)))
          AND IssuerId <> @id
        ORDER BY IsActive DESC, IssuerId
        LIMIT 1
      `);

    const row = result.recordset[0];
    if (!row) return null;
    return {
      issuerId: Number(row['IssuerId']),
      name: String(row['Name']),
      isActive: Number(row['IsActive']) === 1,
    };
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
        -- ALPHABETICAL, NOT SortOrder. SortOrder is a curator's order --
        -- the seed bands it modern / historical / ancient -- and with 70
        -- issuers on screen that is an order nobody can scan. Catalogs
        -- deliberately does the opposite (see catalogs.ts) because its
        -- list is short and its numbering is meaningful; this one is
        -- neither. The default collation is case-insensitive, so Name
        -- alone already folds case; IssuerId makes the order TOTAL, which
        -- a paged or re-fetched list needs.
        ORDER BY i.Name, i.IssuerId
      `);

      return result.recordset.map((row: Record<string, unknown>) => ({
        issuerId: row['IssuerId'],
        name: row['Name'],
        // CHAR(2) can come back space-padded, so trim. Null stays null.
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

/**
 * Brings a soft-deleted issuer back with the submitted fields, reusing its
 * row and id so anything referencing it still works.
 *
 * Its denominations are reactivated too: they were removed by the delete
 * cascade, and leaving them dead would push the user to re-add them,
 * creating duplicate labels that make coin resolution ambiguous. Coin links
 * are not restored (the cascade nulled them), so coins stay unlinked until
 * re-selected.
 *
 * Denominations the user deleted individually before removing the issuer
 * also come back, as nothing distinguishes them; the count is reported to
 * the user. One transaction, so the issuer and its denominations revive
 * together.
 */
async function reviveIssuer(
  issuerId: number,
  issuer: ValidIssuerBody,
  kind: IssuerKind
): Promise<{ sortOrder: number; denominationsRestored: number; denominationCount: number; coinCount: number }> {
  return withDb(async (db) => {
    const transaction = new DbTransaction(db);
    let began = false;

    try {
      await transaction.begin();
      began = true;

      // Apply what the user just typed rather than the old values.
      const revived = await new DbRequest(transaction)
        .input('id', DB_BINDINGS.issuerId, issuerId)
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        // SortOrder keeps the row's existing slot.
        .query(`
          UPDATE Issuers
          SET Name = @name, IsoCode = @isoCode, Kind = @kind,
              ValidFrom = @validFrom, ValidTo = @validTo, IsActive = 1
          WHERE IssuerId = @id
          RETURNING SortOrder
        `);

      const denominations = await new DbRequest(transaction)
        .input('id', DB_BINDINGS.issuerId, issuerId)
        .query('UPDATE Denominations SET IsActive = 1 WHERE IssuerId = @id AND IsActive = 0');

      // Counted after the revive so the response reports current state
      // (CoinCount is expected to be 0 after the cascade).
      const counts = await new DbRequest(transaction)
        .input('id', DB_BINDINGS.issuerId, issuerId)
        .query(`
          SELECT
              COUNT(DISTINCT d.DenominationId) AS DenominationCount,
              COUNT(c.CoinId)                  AS CoinCount
          FROM Denominations d
          LEFT JOIN Coins c ON c.DenominationId = d.DenominationId
          WHERE d.IssuerId = @id AND d.IsActive = 1
        `);

      await transaction.commit();

      const countRow = counts.recordset[0] ?? {};
      return {
        sortOrder: Number(revived.recordset[0]?.['SortOrder'] ?? 0),
        denominationsRestored: denominations.rowsAffected[0] ?? 0,
        denominationCount: Number(countRow['DenominationCount'] ?? 0),
        coinCount: Number(countRow['CoinCount'] ?? 0),
      };
    } catch (innerErr) {
      await safeRollback(began ? transaction : null, 'POST /api/issuers (revive)');
      throw innerErr;
    }
  });
}

/*
 * POST: create an issuer, or revive a removed one.
 *
 *   no row owns the name        -> 201, new row
 *   an active row owns it       -> 409 (the seed matches by name, so two live
 *                                  'Mexico' rows must be impossible)
 *   a deactivated row owns it   -> 200, that row revived with the same id
 *
 * The revive response includes `revived: true` and `denominationsRestored`.
 */
router.post('/issuers', async (req: Request, res: Response) => {
  const parsed = readIssuerBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const issuer = parsed.value;

  try {
    const match = await findNameMatch(issuer.name, null);

    if (match?.isActive) {
      logWarn(`Refusing duplicate issuer name: ${issuer.name}`);
      res.status(409).json({ error: `"${match.name}" is already an issuer` });
      return;
    }

    if (match) {
      // Fallback is the row's own Kind, as in PUT.
      const kind = resolveIssuerKind(
        issuer.validFrom,
        issuer.validTo,
        issuer.suppliedKind ?? (await storedKindOf(match.issuerId))
      );

      logInfo(`Reviving soft-deleted issuer ${match.issuerId}: ${issuer.name} (${kind}, derived)`);
      const outcome = await reviveIssuer(match.issuerId, issuer, kind);
      logInfo(
        `Issuer ${match.issuerId} revived; ${outcome.denominationsRestored} denomination(s) restored`
      );

      res.status(200).json({
        issuerId: match.issuerId,
        name: issuer.name,
        isoCode: issuer.isoCode,
        kind,
        validFrom: issuer.validFrom,
        validTo: issuer.validTo,
        sortOrder: outcome.sortOrder,
        denominationCount: outcome.denominationCount,
        coinCount: outcome.coinCount,
        isActive: true,
        // `revived` drives the message; the count decides whether the online lookup runs.
        revived: true,
        denominationsRestored: outcome.denominationsRestored,
      });
      return;
    }

    // Derived; with no years and no supplied kind it becomes 'modern'.
    const kind = resolveIssuerKind(issuer.validFrom, issuer.validTo, issuer.suppliedKind);

    logInfo(`Creating issuer: ${issuer.name} (${kind}, derived)`);

    const created = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        // SortOrder computed in SQL so concurrent adds can't share a slot and
        // user additions go after the seeded rows. Not used for GET ordering.
        .query(`
          INSERT INTO Issuers (Name, IsoCode, Kind, ValidFrom, ValidTo, SortOrder, IsActive)
          SELECT @name, @isoCode, @kind, @validFrom, @validTo, COALESCE(MAX(SortOrder), 0) + 10, 1
          FROM Issuers
          RETURNING IssuerId, SortOrder
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
      kind,
      validFrom: issuer.validFrom,
      validTo: issuer.validTo,
      sortOrder: created['SortOrder'] ?? 0,
      // Returned so the client can add the row without a reload.
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
    // A deactivated name is still refused on PUT (the UPDATE would hit
    // UQ_Issuers_Name); only the message differs.
    const match = await findNameMatch(issuer.name, id);
    if (match) {
      res.status(409).json({
        error: match.isActive
          ? `"${match.name}" is already an issuer`
          : `"${match.name}" is a removed issuer that still holds that name. ` +
            `Add it again from the Issuers list to bring it back, with its denominations.`,
      });
      return;
    }

    // Fallback is the current Kind, so undated issuers aren't reset to 'modern'.
    const kind = resolveIssuerKind(
      issuer.validFrom,
      issuer.validTo,
      issuer.suppliedKind ?? (await storedKindOf(id))
    );

    logInfo(`Updating issuer ${id} (${kind}, derived)`);

    const rowsAffected = await withDb(async (db) => {
      const result = await db.request()
        .input('id', DB_BINDINGS.issuerId, id)
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, kind)
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
      kind,
      validFrom: issuer.validFrom,
      validTo: issuer.validTo,
      isActive: true,
    });
  } catch (err) {
    sendDbError(res, 'PUT /api/issuers/:id', err, 'Failed to update issuer');
  }
});

/**
 * Soft-deletes an issuer, cascading to its denominations and their coins.
 *
 * A soft delete doesn't trigger the foreign key, so live denominations would
 * be left pointing at an invisible issuer. Instead, in one transaction:
 *   1. unlink coins from the issuer's active denominations (must come first:
 *      the subquery filters on IsActive = 1);
 *   2. deactivate those denominations;
 *   3. deactivate the issuer.
 *
 * Only Coins.DenominationId is cleared; Coins.Denomination (the recorded
 * text) is untouched, so re-selecting a denomination relinks the coin. The
 * response reports both counts.
 */
router.delete('/issuers/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(toSingleValue(req.params['id']), 10);

  try {
    const outcome = await withDb(async (db) => {
      const transaction = new DbTransaction(db);
      let began = false;

      try {
        await transaction.begin();
        began = true;

        const unlinked = await new DbRequest(transaction)
          .input('id', DB_BINDINGS.issuerId, id)
          .query(`
            UPDATE Coins SET DenominationId = NULL
            WHERE DenominationId IN (
              SELECT DenominationId FROM Denominations
              WHERE IssuerId = @id AND IsActive = 1
            )
          `);

        const denominations = await new DbRequest(transaction)
          .input('id', DB_BINDINGS.issuerId, id)
          .query('UPDATE Denominations SET IsActive = 0 WHERE IssuerId = @id AND IsActive = 1');

        const issuer = await new DbRequest(transaction)
          .input('id', DB_BINDINGS.issuerId, id)
          .query('UPDATE Issuers SET IsActive = 0 WHERE IssuerId = @id');

        const issuerRows = issuer.rowsAffected[0] ?? 0;

        // No such issuer: roll back.
        if (issuerRows === 0) {
          await safeRollback(transaction, 'DELETE /api/issuers/:id');
          return null;
        }

        await transaction.commit();

        return {
          denominationsRemoved: denominations.rowsAffected[0] ?? 0,
          coinsUnlinked: unlinked.rowsAffected[0] ?? 0,
        };
      } catch (innerErr) {
        await safeRollback(began ? transaction : null, 'DELETE /api/issuers/:id');
        throw innerErr;
      }
    });

    if (outcome === null) {
      logWarn(`Issuer not found: ${id}`);
      res.status(404).json({ error: 'Issuer not found' });
      return;
    }

    logInfo(
      `Issuer ${id} soft-deleted; ${outcome.denominationsRemoved} denomination(s) removed, ` +
        `${outcome.coinsUnlinked} coin(s) unlinked`
    );
    res.json({ issuerId: id, ...outcome });
  } catch (err) {
    sendDbError(res, 'DELETE /api/issuers/:id', err, 'Failed to delete issuer');
  }
});

export default router;
