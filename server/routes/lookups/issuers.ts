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
 *                           counts, A-Z by name
 *   POST   /issuers      -> create one (201), or REVIVE the soft-deleted row
 *                           that already holds the name (200, same id, its
 *                           denominations back with it)
 *   PUT    /issuers/:id  -> edit one IN PLACE, keeping its id
 *   DELETE /issuers/:id  -> soft-delete (IsActive = 0) and CASCADE: its
 *                           denominations go with it and their coins are
 *                           unlinked, all in one transaction
 *
 * The seed (migration 013) covers 70 issuers, chosen for accuracy over
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
 * 1a. REMOVAL IS A SOFT DELETE, SO THE NAME IS STILL TAKEN AFTERWARDS, and
 *    POST is the half of that fact the user meets. Re-adding a removed
 *    issuer used to answer "already an issuer" about a row that was not on
 *    the screen. It now revives the row instead, keeping its id so anything
 *    still pointing at it survives, and brings its denominations back with
 *    it. The full argument — including why `AND IsActive = 1` on the
 *    duplicate check is NOT the fix, and what happens to denominations the
 *    user had deleted one by one — is on `findNameMatch` and `reviveIssuer`
 *    below.
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
 * 2a. KIND IS NOW DERIVED FROM THE YEAR SPAN AND NOT TAKEN FROM THE CLIENT.
 *    See issuer-kind.ts for the rule and the measurement behind it. The form
 *    stopped asking for it, because it drives no behaviour and the years
 *    already say it. Two consequences live in this file:
 *      * A `kind` in the body is still REFUSED if it is not one of the three
 *        (a client sending 'imaginary' is broken and should hear so), but it
 *        no longer decides the stored value. It is consulted only when the
 *        year span is empty and therefore says nothing.
 *      * PUT reads the row's CURRENT Kind first and falls back to it for an
 *        undated issuer, which is what stops `British Colonial` -- the one
 *        seeded issuer with no dates and a curated 'historical' -- being
 *        silently rewritten the first time somebody fixes a typo in it.
 *
 * 3. PUT EDITS IN PLACE. Denominations reference an issuer BY ID, so
 *    remove-and-re-add — all the text lookups offer — would orphan every
 *    denomination filed under it. Same argument as catalogs.ts.
 *
 * 4. DELETE CASCADES, ATOMICALLY. It used to refuse with a 409 while any
 *    denomination was still filed under the issuer. That refusal is gone —
 *    see the block above the handler for what replaced it and why a
 *    half-removed issuer must be impossible rather than merely unlikely.
 *
 * Every database call runs inside `withDb()` and every parameter type comes
 * from DB_BINDINGS so it matches setup-database.sql.
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
 * The rows a client sent, checked and normalised, or the reason they are not
 * usable. Shared by POST and PUT so the two cannot drift about what a legal
 * issuer looks like — which is the usual way a "you can create it but not
 * edit it to the same value" bug appears.
 */
interface ValidIssuerBody {
  name: string;
  isoCode: string | null;
  /**
   * A `kind` the client happened to send. NOT the value that gets stored —
   * see note 2a in the header. It is consulted only when the year span is
   * empty, and is null for the current form, which no longer sends one.
   */
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

  // Absent is the normal case: the form derives kind from the years and
  // sends none. Present-but-wrong is still a 400, because Kind is
  // NVARCHAR(20) with no CHECK constraint and a client that believes it can
  // set 'imaginary' is a client with a bug worth hearing about. Present-and-
  // valid is accepted but does NOT decide the stored value; see note 2a.
  const rawKind = raw['kind'];
  let suppliedKind: IssuerKind | null = null;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    const text = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : rawKind;
    if (!isIssuerKind(text)) {
      return { ok: false, error: "kind must be one of 'modern', 'historical' or 'ancient'" };
    }
    suppliedKind = text;
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

  return { ok: true, value: { name, isoCode, suppliedKind, validFrom, validTo } };
}

/**
 * The Kind column as it stands on a row right now, or null if there is no
 * such row.
 *
 * PUT needs it so that an issuer whose years say nothing keeps the kind it
 * already had instead of being reset. `British Colonial` is that issuer.
 */
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
  /** FALSE means the row is soft-deleted — the whole reason this type exists. */
  isActive: boolean;
}

/**
 * Which OTHER issuer row, if any, already owns this name — ACTIVE OR NOT.
 *
 * *** IT DELIBERATELY DOES NOT FILTER ON IsActive, AND IT MUST NOT. ***
 * This used to return a bare name and the callers treated every hit as a
 * refusal, which is the bug the owner met: he removed some issuers, tried to
 * add them back, and was told they already existed. They did exist — as
 * rows with `IsActive = 0`, invisible to GET and to the form's own duplicate
 * check, still holding the name.
 *
 * *** AND `AND IsActive = 1` IS NOT THE FIX. *** Hiding the deactivated row
 * from this query would let POST reach its INSERT, and schema.sql's
 * `CONSTRAINT UQ_Issuers_Name UNIQUE (Name)` would then throw
 * "UNIQUE constraint failed: Issuers.Name" — a 500 with SQL in it, for the
 * same user action that previously got an explicable 409. Measured, not
 * assumed. The constraint is also on a `COLLATE NOCASE` column, so it fires
 * for 'mexico' against 'Mexico' too.
 *
 * So the answer carries WHICH row and WHETHER IT IS LIVE, and POST decides:
 * a live row is still a refusal, a dead one is revived. See the block above
 * the POST handler.
 *
 * `excludeId` is what lets PUT leave the name alone: without it, saving an
 * issuer whose name you did not change would fail against itself, which is
 * a maddening bug to meet when all you wanted was to add an end date.
 *
 * Compared with LOWER(LTRIM(RTRIM(...))) rather than by exact equality,
 * because 'mexico ' and 'Mexico' are the same issuer to a human. That
 * comparison is WIDER than UQ_Issuers_Name, which folds case but not
 * whitespace — so 'Mexico ' and 'Mexico' really can both be rows, and both
 * can match here. ORDER BY IsActive DESC is what makes the live one win:
 * an active clash has to stay a refusal even when a deactivated near-miss
 * sorts first by id.
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

/**
 * Bring a soft-deleted issuer back, with the fields the user just typed.
 *
 * *** IT REUSES THE ROW AND ITS ID, AND THAT IS THE POINT. ***
 * Denominations reference an issuer BY ID. Inserting a second 'Burma' with
 * a new id would leave every denomination that was ever filed under the old
 * one pointing at a row GET no longer returns — the exact orphan state the
 * cascade in DELETE exists to make impossible. Same argument as PUT editing
 * in place; see note 3 in the header.
 *
 * *** THE DENOMINATIONS COME BACK WITH IT. THE DECISION, AND WHY. ***
 * They were deactivated by the CASCADE, not chosen one by one: the user
 * removed an issuer and was told its denominations went with it. The
 * symmetric undo of "the issuer goes and takes them" is "the issuer comes
 * back and brings them", and leaving them dead under a live issuer
 * recreates the invisible-orphan state in mirror image — rows that exist,
 * are filed under something the user can see, and are reachable from
 * nothing. The user's next act would then be to type them again, or to
 * accept them from the online lookup, producing a SECOND row with the same
 * label under one issuer. That is the duplicate seed-sql.ts is written
 * against: two rows sharing a label make every coin carrying that text
 * resolve as ambiguous, and ambiguous resolves to NULL, so the duplicate
 * costs a denomination rather than adding one.
 *
 * It also matters that the seeded denominations are OTHERWISE
 * UNRECOVERABLE. Removing Mexico takes 31 curated rows with it and there is
 * no screen anywhere that puts them back.
 *
 * *** THE OBJECTION IN denominations.ts DOES NOT APPLY HERE. *** That file
 * records, correctly, that reactivating a denomination "would silently
 * re-link coins the user had already decided to detach". It cannot happen
 * on this path: the cascade set `Coins.DenominationId = NULL`, so the link
 * is already gone and reviving the label does not restore it. The coins
 * stay unlinked, keep their recorded text, and still read as Other until
 * the user re-selects — exactly what the removal promised.
 *
 * *** THE ONE THING THIS OVER-RESTORES, STATED PLAINLY. *** A denomination
 * the user deleted INDIVIDUALLY before removing the issuer is also
 * deactivated, and nothing in the schema distinguishes it from one the
 * cascade took — there is no deactivation timestamp and adding a column for
 * this is not worth a migration. So it comes back too. That is the cheaper
 * error of the two: a label that should not be there is one click to remove
 * again, while 31 curated rows that did not come back cannot be got back at
 * all. And it is not silent — the count is reported and the caller says it
 * out loud.
 *
 * ONE TRANSACTION, for the reason DELETE is one: an issuer that came back
 * without its denominations, or denominations reactivated under an issuer
 * that did not, are both states the user cannot see and cannot repair.
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

      // The row itself: alive again, carrying what the user just submitted
      // rather than whatever it held when it was removed. They retyped it,
      // so it is their current answer, and refusing to apply it would make
      // "add Burma, 1948-1989" quietly store the old year span.
      const revived = await new DbRequest(transaction)
        .input('id', DB_BINDINGS.issuerId, issuerId)
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        // SortOrder is NOT rewritten. It is the row's own slot and it was
        // never the problem; a revived issuer belongs where it already was.
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

      // Counted from the database AFTER the revive rather than assumed to
      // be the number just reactivated. The two are normally the same and
      // the response is the screen's only source for the row's badge, so it
      // should report the state rather than the delta. CoinCount is
      // expected to be 0 — the cascade unlinked them — but it is measured,
      // not asserted, for the same reason.
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
 * POST — create one, OR BRING A REMOVED ONE BACK.
 *
 * *** THE SECOND HALF IS A BUG FIX, REPORTED AFTER TESTING. ***
 * "The Edit/Delete of Issuer looks like it worked, except when I tried to
 * add them back in, I got an error saying the Issuer(s) already exist."
 * Removal is a SOFT delete, the deactivated row kept the name, and the
 * duplicate check counted it. The form's own check could not catch it
 * either — it compares against the ACTIVE list, which is the only list the
 * client has — so the user had no warning and no way round it.
 *
 * Three outcomes now, and only the middle one is new:
 *
 *   no row owns the name          -> 201, a new row
 *   an ACTIVE row owns it         -> 409, unchanged. Two live issuers
 *                                    called Mexico must stay impossible:
 *                                    the seed matches BY NAME and a second
 *                                    one makes its join multiply rows.
 *   a DEACTIVATED row owns it     -> 200, that row revived, same id
 *
 * 200 and not 201: nothing was created. The body carries `revived: true`
 * and `denominationsRestored`, which is what the client actually branches
 * on — the status is there so the protocol is not lying about what
 * happened.
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
      // DERIVED with the row's OWN Kind as the fallback, exactly as PUT
      // does it, because there IS a row. Without it, reviving the undated
      // `British Colonial` would silently reclassify it as 'modern'.
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
        // The two fields that make this answer different from a creation.
        // The client needs BOTH: `revived` decides the sentence, and the
        // count decides whether the online lookup runs at all.
        revived: true,
        denominationsRestored: outcome.denominationsRestored,
      });
      return;
    }

    // DERIVED, not taken from the body. No row exists yet, so an issuer
    // with no years at all becomes 'modern' unless the client insisted
    // otherwise — see issuer-kind.ts.
    const kind = resolveIssuerKind(issuer.validFrom, issuer.validTo, issuer.suppliedKind);

    logInfo(`Creating issuer: ${issuer.name} (${kind}, derived)`);

    const created = await withDb(async (db) => {
      const result = await db.request()
        .input('name', DB_BINDINGS.issuerName, issuer.name)
        .input('isoCode', DB_BINDINGS.issuerIsoCode, issuer.isoCode)
        .input('kind', DB_BINDINGS.issuerKind, kind)
        .input('validFrom', DB_BINDINGS.issuerYear, issuer.validFrom)
        .input('validTo', DB_BINDINGS.issuerYear, issuer.validTo)
        // SortOrder computed in SQL, for the same reason catalogues do it:
        // two tabs cannot both claim the same slot, and a user's addition
        // belongs AFTER the seeded 70 rather than jumping above them.
        // GET no longer orders by it — the list is A-Z — but the column is
        // NOT NULL and is still the stored curator's order, so a new row
        // needs a value that is its own and is not zero.
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
    // PUT STILL REFUSES A DEACTIVATED NAME, and it has to: letting the
    // UPDATE through would hit UQ_Issuers_Name and turn a 409 into a 500
    // with SQL in it. Renaming is also the wrong instrument for it —
    // merging this issuer into a removed one would abandon this issuer's
    // own denominations. What changes here is only the WORDING, because
    // "already an issuer" is baffling when the issuer is not in the list.
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

    // DERIVED, with the row's CURRENT Kind as the fallback for an issuer
    // whose years say nothing. That fallback is the whole reason this read
    // exists: without it, saving `British Colonial` — no dates, curated as
    // 'historical' — would silently rewrite it to 'modern'.
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
 * Soft-delete an issuer, CASCADING to its denominations and their coins.
 *
 * *** THIS ROUTE USED TO REFUSE, AND THE REFUSAL WAS THE BUG. ***
 * It answered 409 while any active denomination was filed under the issuer,
 * on the argument that the user should move or remove them first. In
 * practice the owner did exactly that, the screen's cached count never
 * caught up, and Remove refused forever. "I tried removing the
 * denominations first, but that didn't work" is that story. The refusal
 * also stood in for a rename the UI never offered, so the one person who
 * hit it was not trying to delete anything at all.
 *
 * What the refusal was protecting against is still real, so it is handled
 * rather than dropped. The delete is SOFT (IsActive = 0), so
 * FK_Denominations_Issuer never fires — it only guards an actual row
 * deletion — and denominations left behind would keep an IssuerId pointing
 * at a row GET no longer returns, reappearing under "No issuer yet" in a
 * list of over a thousand with nothing saying why. So they are NOT left
 * behind: they are deactivated in the same breath, and their coins are
 * unlinked exactly the way DELETE /denominations/:id unlinks them.
 *
 * *** THE THREE STATEMENTS ARE ONE TRANSACTION, AND THAT IS NOT OPTIONAL. ***
 * A half-removed issuer — gone from the list, with live denominations still
 * filed under it — is strictly worse than the refusal this replaces: the
 * user cannot see the orphans, cannot reach them, and has no reason to
 * suspect them. Either all three land or none do.
 *
 * ORDER MATTERS. The coins are unlinked BEFORE the denominations are
 * deactivated, because the subquery that finds them filters on
 * `IsActive = 1`. Swap the two and the UPDATE matches nothing, the response
 * reports zero coins touched, and the rows it should have cleared keep
 * pointing at denominations that no longer exist.
 *
 * *** NOTHING HERE WRITES TO Coins.Denomination. *** Only the id link is
 * cleared. The recorded TEXT is the user's own evidence of what the coin
 * says and it survives untouched, which is what lets the client promise
 * that no coin is lost and that re-selecting a denomination re-links it.
 * See services/denominations/denomination-display.ts for what a coin in
 * that state renders as — and for the sentinel that must never be written
 * into the column in place of this.
 *
 * The response carries both counts so the caller can report what actually
 * happened rather than what it predicted would happen.
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

        // No such issuer. Roll back rather than commit a no-op: it costs
        // nothing here and it means the only way this transaction ever
        // commits is the way that removes all three.
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
