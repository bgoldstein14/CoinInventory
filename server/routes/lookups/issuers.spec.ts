/**
 * routes/lookups/issuers.spec.ts — the Issuers reference table.
 *
 * Issuers became maintainable when the maintenance screen was rebuilt: the
 * seed covers 70 of them and a collector who buys one Burmese coin needs a
 * 71st without waiting for a release.
 *
 * *** THE 70 ISSUERS BELOW ARE THE REAL ONES. *** This file runs against the
 * in-memory SQLite database built from db/schema.sql and seeded from
 * migrations/seed-data/issuers-denominations.json, so GET /api/issuers
 * returns the actual seeded list and POST really has to get past
 * UQ_Issuers_Name. The previous version queued canned recordsets on a
 * hand-written mssql mock, which meant "refuses a duplicate name" proved the
 * route read a recordset the test had just written, not that two issuers
 * called Mexico are impossible.
 *
 * Three things here are not shared with the other lookup routes, and each
 * has its own test below:
 *
 *   * GET carries the counts the screen needs to say "23 denominations, 7
 *     coins" BEFORE the user presses Remove.
 *   * POST refuses a duplicate name itself rather than letting
 *     UQ_Issuers_Name turn into a 500 with SQL in the message.
 *   * DELETE CASCADES to the issuer's denominations and unlinks their coins,
 *     in one transaction. It is a SOFT delete, so FK_Denominations_Issuer
 *     will not catch an orphan for us — the transaction is what guarantees
 *     there is never one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import {
  executedSql,
  findQuery,
  queryRows,
  insertCoin,
  withTestDb,
  rebuildTestDatabase,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// Nearly every test here adds, edits or deactivates an Issuers row, and
// Issuers is SEEDED reference data that the ordinary per-test reset
// deliberately leaves alone. Rebuilding puts the 70 back.
beforeEach(async () => {
  await rebuildTestDatabase();
});

/** The seeded issuer with this name, as the database actually stored it. */
async function issuerNamed(name: string): Promise<Record<string, unknown>> {
  const rows = await queryRows('SELECT * FROM Issuers WHERE Name = @name', { name });
  expect(rows, `no seeded issuer called ${name}`).toHaveLength(1);
  return rows[0];
}

describe('GET /api/issuers', () => {
  it('returns the maintenance shape, counts included', async () => {
    const mexico = await issuerNamed('Mexico');
    const [denomination] = await queryRows(
      'SELECT DenominationId FROM Denominations WHERE IssuerId = @id ORDER BY SortOrder LIMIT 1',
      { id: Number(mexico['IssuerId']) }
    );
    // Four coins, all on ONE of Mexico's denominations: the join multiplies
    // a denomination row once per coin, which is what the COUNT(DISTINCT)
    // in the query exists to survive.
    for (let i = 0; i < 4; i += 1) {
      await insertCoin({
        CoinId: `mx-${i}`,
        Denomination: '8 Reales',
        DenominationId: Number(denomination['DenominationId']),
      });
    }

    const res = await request(app).get('/api/issuers');
    expect(res.status).toBe(200);

    const row = res.body.find((issuer: { name: string }) => issuer.name === 'Mexico');
    expect(row).toEqual({
      issuerId: Number(mexico['IssuerId']),
      name: 'Mexico',
      isoCode: 'MX',
      kind: 'modern',
      validFrom: 1821,
      validTo: null,
      sortOrder: 130,
      // The real number of denominations the seed files under Mexico.
      denominationCount: 31,
      coinCount: 4,
      isActive: true,
    });
  });

  it('keeps a null ISO code null instead of inventing an empty string', async () => {
    // Half this table has no ISO code and never will — every ancient and
    // most historical states. '' would render as a blank two-letter box that
    // looks like missing data rather than an absent concept.
    const res = await request(app).get('/api/issuers');

    const romanEmpire = res.body.find((issuer: { name: string }) => issuer.name === 'Roman Empire');
    expect(romanEmpire.isoCode).toBeNull();
    expect(romanEmpire.validFrom).toBe(-27);
  });

  it('counts denominations and coins without dropping an issuer that has neither', async () => {
    // A LEFT JOIN, not an INNER one: a newly added Burma has no
    // denominations and must still appear, or the user cannot add any.
    // Asserted on the outcome now — the row comes back with two zeroes —
    // rather than on the word LEFT appearing in the SQL.
    await withTestDb((database) => {
      database
        .prepare(
          'INSERT INTO Issuers (Name, IsoCode, Kind, SortOrder, IsActive) ' +
            "VALUES ('Burma', 'MM', 'modern', 3000, 1)"
        )
        .run();
    });

    const res = await request(app).get('/api/issuers');
    const burma = res.body.find((issuer: { name: string }) => issuer.name === 'Burma');
    expect(burma).toBeDefined();
    expect(burma.denominationCount).toBe(0);
    expect(burma.coinCount).toBe(0);
  });

  it('returns only active issuers', async () => {
    await withTestDb((database) => {
      database.prepare("UPDATE Issuers SET IsActive = 0 WHERE Name = 'Peru'").run();
    });

    const res = await request(app).get('/api/issuers');
    const names = res.body.map((issuer: { name: string }) => issuer.name);
    expect(names).not.toContain('Peru');
    // The other 69 are still there, so this is not "the query broke".
    expect(res.body).toHaveLength(69);
  });

  it('orders them alphabetically by name, not by SortOrder', async () => {
    // The owner's request: "the Issuers and Denominations screens need to
    // have the Issuers in alphabetic order." SortOrder is the seed's
    // curator order -- modern 100-420, historical 1000-1150, ancient
    // 2000-2120 and 3000-3070 -- which puts Portugal between Spain and Italy. With 70
    // issuers that is not a list anybody can scan.
    const res = await request(app).get('/api/issuers');
    const names: string[] = res.body.map((issuer: { name: string }) => issuer.name);

    // Alphabetical, case-insensitively (Issuers.Name is COLLATE NOCASE).
    const alphabetical = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(alphabetical);

    // And emphatically NOT the curator order, which would open on the
    // United States (SortOrder 100) rather than Achaemenid Persia.
    expect(names[0]).toBe('Achaemenid Persia');
    const sortOrders: number[] = res.body.map((issuer: { sortOrder: number }) => issuer.sortOrder);
    expect(sortOrders).not.toEqual([...sortOrders].sort((a, b) => a - b));
  });

  it('breaks a name tie on the id so the order is total', async () => {
    // Without a second key the order of two rows the engine considers equal
    // is undefined, and a re-fetch can hand the screen the same list in a
    // different order.
    //
    // *** THE ONLY SQL-TEXT ASSERTION IN THIS FILE, AND IT HAS TO BE. ***
    // UQ_Issuers_Name is NOCASE, so two issuers the ORDER BY would consider
    // tied CANNOT BE CREATED — the outcome this guards is unreachable from
    // the outside. Asserted on the ORDER BY clause specifically rather than
    // on the whole query text: SortOrder is still SELECTed and still GROUPed
    // BY, so a bare "does not mention SortOrder" check would be testing the
    // wrong thing and would fail for the wrong reason.
    await request(app).get('/api/issuers');

    const sql = findQuery(/FROM Issuers i/)?.sql ?? '';
    const clause = /ORDER BY([^\n]*)/i.exec(sql)?.[1] ?? '';
    expect(clause).toMatch(/i\.Name\s*,\s*i\.IssuerId/i);
    expect(clause).not.toMatch(/SortOrder/i);
  });

  it('still SELECTs SortOrder, because the client still carries it', async () => {
    // Dropping the column would be the over-correction: IssuerRecord has a
    // non-optional sortOrder, POST returns the value it computed, and the
    // seed's banding is still the stored order of record. A route that
    // stopped selecting it would answer 0 for every row.
    const res = await request(app).get('/api/issuers');

    const unitedStates = res.body.find((issuer: { name: string }) => issuer.name === 'United States');
    expect(unitedStates.sortOrder).toBe(100);
    expect(res.body.every((issuer: { sortOrder: number }) => issuer.sortOrder > 0)).toBe(true);
  });
});

describe('POST /api/issuers', () => {
  it('refuses a missing name', async () => {
    const res = await request(app).post('/api/issuers').send({ kind: 'modern' });
    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });

  it('refuses a whitespace-only name', async () => {
    const res = await request(app).post('/api/issuers').send({ name: '   ', kind: 'modern' });
    expect(res.status).toBe(400);
  });

  it('refuses a kind the Kind column does not define', async () => {
    // Kind is NVARCHAR(20) with no CHECK constraint, so the database would
    // happily store 'imaginary' and the UI would then have a row it cannot
    // group, filter or render an icon for.
    const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'imaginary' });
    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });

  it('refuses an ISO code that is not exactly two letters', async () => {
    // IsoCode is CHAR(2). SQL Server TRUNCATED 'MMR' and PADDED 'M', both
    // silently, and the padded one then compared unequal to 'M' everywhere.
    // SQLite pads nothing, but db/bind-values.ts still refuses a third
    // character, and the route refuses all three of these before that.
    for (const isoCode of ['M', 'MMR', '1M']) {
      const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern', isoCode });
      expect(res.status, `expected ${isoCode} to be refused`).toBe(400);
    }

    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Burma'")).toEqual([]);
  });

  it('refuses a duplicate name with a 409 instead of a SQL error', async () => {
    // UQ_Issuers_Name. Letting the constraint fire returns a 500 carrying the
    // driver's own message, and the seed script matches issuers BY NAME, so a
    // second 'Mexico' makes its join multiply rows rather than fail. The
    // seeded Mexico is the one being collided with here.
    const res = await request(app).post('/api/issuers').send({ name: ' mexico ', kind: 'modern' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mexico');

    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Mexico'")).toHaveLength(1);
  });

  it('creates an issuer and returns it with its new id', async () => {
    // *** THE BODY STILL CARRIES kind: 'modern' AND THE ROW IS STORED AS
    // 'historical'. *** That is the point of the change, not a bug in the
    // test. Kind is DERIVED from the year span now (issuer-kind.ts), and
    // Burma 1948-1989 has an end year, so it is historical — which is also
    // simply true: Burma became Myanmar in 1989. The old form made the
    // user pick, and 'modern' was its default, so this is exactly the
    // wrong answer the picker used to let through.
    const res = await request(app)
      .post('/api/issuers')
      .send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm', validFrom: 1948, validTo: 1989 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      // 70 seeded rows, so AUTOINCREMENT hands this one 71.
      issuerId: 71,
      name: 'Burma',
      isoCode: 'MM',
      kind: 'historical',
      validFrom: 1948,
      validTo: 1989,
      denominationCount: 0,
      coinCount: 0,
      isActive: true,
    });

    const [stored] = await queryRows('SELECT * FROM Issuers WHERE IssuerId = 71');
    expect(stored).toMatchObject({
      Name: 'Burma',
      IsoCode: 'MM',
      Kind: 'historical',
      ValidFrom: 1948,
      ValidTo: 1989,
      IsActive: 1,
    });
  });

  it('derives the kind from the years, and the form sends none at all', async () => {
    // The three branches, through the real route, with no `kind` in the
    // body — which is what the rebuilt issuer form now sends.
    const cases = [
      { name: 'Miletos', validFrom: -600, validTo: -400, kind: 'ancient' },
      { name: 'Kingdom of Westphalia', validFrom: 1807, validTo: 1813, kind: 'historical' },
      { name: 'Namibia', validFrom: 1990, kind: 'modern' },
      // No years at all. 12 of the 13 undated seeded issuers are modern.
      { name: 'Somewhere Undated', kind: 'modern' },
    ];

    for (const { kind, ...body } of cases) {
      const res = await request(app).post('/api/issuers').send(body);
      expect(res.status, `${body.name} was refused`).toBe(201);
      expect(res.body.kind, body.name).toBe(kind);

      const [stored] = await queryRows('SELECT Kind FROM Issuers WHERE Name = @name', { name: body.name });
      expect(stored['Kind'], `${body.name} as stored`).toBe(kind);
    }
  });

  it('files an issuer that began before 500 as ancient even though it ended', async () => {
    // Ancient is tested BEFORE historical. The Byzantine Empire (491-1453)
    // is the seeded row that needs it; this is the same shape, through the
    // route, on a name the seed does not carry.
    const res = await request(app).post('/api/issuers').send({ name: 'Kingdom of Axum', validFrom: 270, validTo: 960 });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('ancient');
  });

  it('trims the name and upper-cases the ISO code before binding them', async () => {
    await request(app).post('/api/issuers').send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm' });

    // The STORED row, not the bound parameter: the row is what the next
    // GET reads, and an untrimmed name would make '  Burma  ' a different
    // issuer from 'Burma' to every lookup that is not NOCASE-and-trimmed.
    const [stored] = await queryRows("SELECT Name, IsoCode FROM Issuers WHERE Kind = 'modern' AND IssuerId = 71");
    expect(stored['Name']).toBe('Burma');
    expect(stored['IsoCode']).toBe('MM');
  });

  it('accepts a BC year as a negative number', async () => {
    // The Roman Republic starts at -509. A route that rejected negatives
    // would exclude the entries the design calls first-class. (The seed
    // already HAS a Roman Republic, so this uses a kingdom it does not
    // carry — the duplicate-name rule is tested on its own above.)
    const res = await request(app)
      .post('/api/issuers')
      .send({ name: 'Kingdom of Pontus', kind: 'ancient', validFrom: -509, validTo: -27 });

    expect(res.status).toBe(201);
    expect(res.body.validFrom).toBe(-509);

    const [stored] = await queryRows("SELECT ValidFrom, ValidTo FROM Issuers WHERE Name = 'Kingdom of Pontus'");
    expect(stored['ValidFrom']).toBe(-509);
    expect(stored['ValidTo']).toBe(-27);
  });

  it('puts a new issuer at the end of the order, computed in SQL', async () => {
    // Computed server-side so two tabs cannot both claim the same slot, and
    // at the END so a user's addition does not jump above the seeded list.
    // The seed's highest SortOrder is 3070 (Hasmonean Kingdom), so the next
    // one is 3080.
    const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern' });

    expect(res.status).toBe(201);
    expect(res.body.sortOrder).toBe(3080);

    const [{ MaxSortOrder: highest }] = await queryRows('SELECT MAX(SortOrder) AS MaxSortOrder FROM Issuers');
    expect(highest).toBe(3080);
  });
});

describe('PUT /api/issuers/:id', () => {
  it('updates an issuer in place, keeping its id', async () => {
    // Rename in place, exactly like catalogues: denominations reference the
    // issuer BY ID, so remove-and-re-add would orphan all of them.
    const mexico = await issuerNamed('Mexico');
    const id = Number(mexico['IssuerId']);

    const res = await request(app)
      .put(`/api/issuers/${id}`)
      .send({ name: 'Mexico (Republic)', kind: 'modern', isoCode: 'MX' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issuerId: id, name: 'Mexico (Republic)' });

    // Same row, new name — and the 31 denominations still point at it.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('Mexico (Republic)');
    expect(await queryRows('SELECT 1 FROM Denominations WHERE IssuerId = @id', { id })).toHaveLength(31);
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
  });

  it('allows an issuer to keep its own name', async () => {
    // The duplicate check must exclude the row being edited, or changing
    // only the dates would fail with "that name is taken" by itself. With a
    // real UNIQUE index behind it, this is the case that actually bites.
    const id = Number((await issuerNamed('Mexico'))['IssuerId']);

    const res = await request(app)
      .put(`/api/issuers/${id}`)
      .send({ name: 'Mexico', kind: 'modern', validTo: 2024 });

    expect(res.status).toBe(200);
    const [stored] = await queryRows('SELECT Name, ValidTo FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('Mexico');
    expect(stored['ValidTo']).toBe(2024);
  });

  it('404s for an id that is not there', async () => {
    const res = await request(app).put('/api/issuers/999').send({ name: 'Nowhere', kind: 'modern' });
    expect(res.status).toBe(404);
    expect(await queryRows("SELECT 1 FROM Issuers WHERE Name = 'Nowhere'")).toEqual([]);
  });

  it('does NOT rewrite British Colonial, the one issuer the rule cannot derive', async () => {
    // *** THE CASE THAT DECIDED THE SHAPE OF THE RULE. ***
    // British Colonial is a catch-all with NO DATES AT ALL, curated as
    // 'historical'. It is the single seeded issuer the derivation does not
    // reproduce. Editing anything about it — here, just fixing the name —
    // must leave the kind alone, because nothing about its years changed.
    //
    // The request sends no `kind`, exactly as the rebuilt form does, so
    // the only thing that can save the value is the route reading the row
    // first.
    const before = await issuerNamed('British Colonial');
    expect(before['Kind']).toBe('historical');
    expect(before['ValidFrom']).toBeNull();
    expect(before['ValidTo']).toBeNull();

    const id = Number(before['IssuerId']);
    const res = await request(app).put(`/api/issuers/${id}`).send({ name: 'British Colonial ' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('historical');

    const [after] = await queryRows('SELECT Kind FROM Issuers WHERE IssuerId = @id', { id });
    expect(after['Kind']).toBe('historical');
  });

  it('DOES reclassify an undated issuer once the user gives it years', () => {
    // The other half of the same rule: a stored kind is a fallback, not a
    // veto. Giving British Colonial a span is the user saying something
    // new, and the span is then believed.
    return issuerNamed('British Colonial').then(async (row) => {
      const id = Number(row['IssuerId']);
      const res = await request(app)
        .put(`/api/issuers/${id}`)
        .send({ name: 'British Colonial', validFrom: -300, validTo: -27 });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('ancient');
    });
  });
});

/*
 * DELETE CASCADES. It used to answer 409 while any denomination was filed
 * under the issuer, which is the refusal the owner met and could not get
 * past: he removed the denominations, the screen's cached count did not
 * move, and the button kept saying no. The refusal is gone and the thing it
 * was protecting against is handled instead — the denominations go with the
 * issuer in the same transaction, so there is never a moment where one is
 * gone and the others are not.
 */
describe('DELETE /api/issuers/:id', () => {
  /** Mexico's active denominations, which the cascade must take with it. */
  async function activeDenominationIds(issuerId: number): Promise<number[]> {
    const rows = await queryRows(
      'SELECT DenominationId FROM Denominations WHERE IssuerId = @id AND IsActive = 1 ORDER BY DenominationId',
      { id: issuerId }
    );
    return rows.map((row) => Number(row['DenominationId']));
  }

  it('cascades to the denominations instead of refusing, and says how many of each', async () => {
    const id = Number((await issuerNamed('Mexico'))['IssuerId']);
    const denominationIds = await activeDenominationIds(id);
    expect(denominationIds).toHaveLength(31);

    await insertCoin({ CoinId: 'mx-a', Denomination: '8 Reales', DenominationId: denominationIds[0] });
    await insertCoin({ CoinId: 'mx-b', Denomination: 'Pillar Dollar', DenominationId: denominationIds[0] });
    await insertCoin({ CoinId: 'mx-c', Denomination: '1 Peso', DenominationId: denominationIds[1] });

    const res = await request(app).delete(`/api/issuers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issuerId: id, denominationsRemoved: 31, coinsUnlinked: 3 });

    const [stored] = await queryRows('SELECT IsActive FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['IsActive']).toBe(0);

    // NOT ONE LEFT ACTIVE. An issuer that is gone with live denominations
    // still filed under it is the state this whole route exists to avoid:
    // they would reappear under "No issuer yet" with nothing saying why.
    expect(await activeDenominationIds(id)).toEqual([]);
  });

  it('unlinks the affected coins and leaves their recorded text alone', async () => {
    // THE FALLBACK TO "OTHER" IS THE NULL LINK, NOT A STRING. The coin keeps
    // what it always said and simply stops pointing at a row that no longer
    // exists; denomination-display.ts turns that pair into the display form.
    // A sentinel written into Coins.Denomination here is a defect this
    // project has already had once.
    const id = Number((await issuerNamed('Mexico'))['IssuerId']);
    const [first] = await activeDenominationIds(id);
    await insertCoin({ CoinId: 'mx-text', Denomination: 'Pillar Dollar', DenominationId: first });

    await request(app).delete(`/api/issuers/${id}`);

    const [coin] = await queryRows(
      'SELECT Denomination, DenominationId FROM Coins WHERE CoinId = @id',
      { id: 'mx-text' }
    );
    expect(coin['DenominationId']).toBeNull();
    expect(coin['Denomination']).toBe('Pillar Dollar');
  });

  it('writes no sentinel into Coins.Denomination for any affected coin', async () => {
    const id = Number((await issuerNamed('Mexico'))['IssuerId']);
    const ids = await activeDenominationIds(id);
    await insertCoin({ CoinId: 'mx-1', Denomination: '8 Reales', DenominationId: ids[0] });
    await insertCoin({ CoinId: 'mx-2', Denomination: '', DenominationId: ids[1] });
    await insertCoin({ CoinId: 'mx-3', Denomination: '1 Peso', DenominationId: ids[2] });

    await request(app).delete(`/api/issuers/${id}`);

    const rows = await queryRows('SELECT CoinId, Denomination FROM Coins ORDER BY CoinId');
    for (const row of rows) {
      expect(String(row['Denomination'] ?? '')).not.toContain('OTHER');
    }
    expect(rows.map((row) => row['Denomination'])).toEqual(['8 Reales', '', '1 Peso']);
  });

  it('touches nothing belonging to another issuer', async () => {
    const mexico = Number((await issuerNamed('Mexico'))['IssuerId']);
    const peru = Number((await issuerNamed('Peru'))['IssuerId']);
    const peruBefore = await activeDenominationIds(peru);
    expect(peruBefore.length).toBeGreaterThan(0);

    const [peruFirst] = peruBefore;
    await insertCoin({ CoinId: 'pe-1', Denomination: '8 Reales', DenominationId: peruFirst });

    await request(app).delete(`/api/issuers/${mexico}`);

    expect(await activeDenominationIds(peru)).toEqual(peruBefore);
    const [coin] = await queryRows('SELECT DenominationId FROM Coins WHERE CoinId = @id', { id: 'pe-1' });
    expect(Number(coin['DenominationId'])).toBe(peruFirst);
  });

  it('soft-deletes an issuer that has no denominations, reporting two zeroes', async () => {
    const created = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern' });
    const id = created.body.issuerId;

    const res = await request(app).delete(`/api/issuers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issuerId: id, denominationsRemoved: 0, coinsUnlinked: 0 });

    // THE ROW IS STILL THERE. A hard delete would also answer 200, and
    // nothing in the response can tell the two apart.
    const [stored] = await queryRows('SELECT IsActive FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored).toBeDefined();
    expect(stored['IsActive']).toBe(0);
  });

  it('404s for an id that is not there, and rolls the transaction back', async () => {
    const res = await request(app).delete('/api/issuers/999');
    expect(res.status).toBe(404);
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
    // Nothing was committed on the way to the 404: every seeded
    // denomination is still active.
    const [{ Live: live }] = await queryRows(
      'SELECT COUNT(*) AS Live FROM Denominations WHERE IsActive = 0'
    );
    expect(Number(live)).toBe(0);
  });
});

/*
 * ===================== RE-ADDING A REMOVED ISSUER =====================
 *
 * *** THE BUG THE OWNER REPORTED AFTER TESTING. *** "The Edit/Delete of
 * Issuer looks like it worked, except when I tried to add them back in, I
 * got an error saying the Issuer(s) already exist."
 *
 * Both halves of the trap are pinned below before anything about the fix,
 * because the second one is what makes the obvious repair wrong:
 *
 *   * The deactivated row still holds the name, and the duplicate check
 *     counted it, so re-adding was refused.
 *   * `AND IsActive = 1` on that check is NOT the fix — it would let the
 *     INSERT through into UQ_Issuers_Name, turning an explicable 409 into
 *     a 500 with "UNIQUE constraint failed" in it, for the same action.
 */
describe('POST /api/issuers — reviving a removed one', () => {
  /** Remove an issuer the way the screen does, and report what went with it. */
  async function removeIssuerNamed(name: string): Promise<{ id: number; denominationsRemoved: number }> {
    const row = await issuerNamed(name);
    const id = Number(row['IssuerId']);
    const res = await request(app).delete(`/api/issuers/${id}`);
    expect(res.status).toBe(200);
    return { id, denominationsRemoved: Number(res.body.denominationsRemoved) };
  }

  it('THE TRAP, HALF ONE: the removed row still holds the name', async () => {
    // Not a test of the fix. A test of the fact the fix exists for: a soft
    // delete leaves the row, and the row keeps Name. Anything that matches
    // on name alone therefore still finds it.
    const { id } = await removeIssuerNamed('Mexico');

    const [stored] = await queryRows('SELECT Name, IsActive FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('Mexico');
    expect(stored['IsActive']).toBe(0);

    // And it is invisible to the screen, which is why the form's own
    // duplicate check cannot catch it either.
    const list = await request(app).get('/api/issuers');
    expect(list.body.some((issuer: { name: string }) => issuer.name === 'Mexico')).toBe(false);
  });

  it('THE TRAP, HALF TWO: UQ_Issuers_Name would fire if the insert were let through', async () => {
    // *** THIS IS WHY `AND IsActive = 1` IS NOT THE FIX. *** Measured
    // against the real constraint in db/schema.sql rather than assumed.
    await removeIssuerNamed('Mexico');

    let message = 'the INSERT was allowed, so the constraint is not what the route claims';
    try {
      await withTestDb((database) => {
        database
          .prepare(
            'INSERT INTO Issuers (Name, IsoCode, Kind, SortOrder, IsActive) ' +
              "VALUES ('Mexico', 'MX', 'modern', 9999, 1)"
          )
          .run();
      });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('UNIQUE constraint failed: Issuers.Name');
  });

  it('THE TRAP, HALF TWO (b): Name is COLLATE NOCASE, so a different case collides too', async () => {
    // A fix that lower-cased its way around the constraint would not work
    // either. 'mexico' and 'Mexico' are one row as far as UQ_Issuers_Name
    // is concerned.
    await removeIssuerNamed('Mexico');

    let message = 'the INSERT was allowed';
    try {
      await withTestDb((database) => {
        database
          .prepare("INSERT INTO Issuers (Name, Kind, SortOrder, IsActive) VALUES ('mexico', 'modern', 9999, 1)")
          .run();
      });
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain('UNIQUE constraint failed: Issuers.Name');
  });

  it('REUSES THE ROW AND ITS ID rather than creating a second one', async () => {
    // *** THE DATA-INTEGRITY PROPERTY OF THE WHOLE CHANGE. *** Denominations
    // and coins reach an issuer BY ID. A revival that minted a new id would
    // leave every row filed under the old one pointing at an issuer GET does
    // not return — the invisible orphan the cascade in DELETE exists to make
    // impossible, arrived at from the other direction.
    const { id } = await removeIssuerNamed('Mexico');

    const res = await request(app).post('/api/issuers').send({ name: 'Mexico', isoCode: 'MX', validFrom: 1821 });

    expect(res.status).toBe(200);
    expect(res.body.issuerId).toBe(id);
    expect(res.body.revived).toBe(true);

    // ONE row called Mexico, and it is the original.
    const rows = await queryRows("SELECT IssuerId, IsActive FROM Issuers WHERE Name = 'Mexico'");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]['IssuerId'])).toBe(id);
    expect(rows[0]['IsActive']).toBe(1);

    // Still 70 issuer rows in total: nothing was inserted.
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
  });

  it('BRINGS THE DENOMINATIONS BACK, still filed under the same issuer id', async () => {
    // *** THE DECISION, PINNED. *** The denominations went as a CASCADE of
    // the issuer removal, not one by one, so the undo of that removal
    // brings them back. The alternative — a live issuer with 31 dead
    // denominations under it — is the invisible-orphan state in mirror
    // image, and the user's next act would be to add the same labels again,
    // producing two rows with one label under one issuer. That duplicate
    // resolves every coin carrying the text to NULL, so it costs a
    // denomination rather than adding one.
    const { id, denominationsRemoved } = await removeIssuerNamed('Mexico');
    expect(denominationsRemoved).toBe(31);

    const res = await request(app).post('/api/issuers').send({ name: 'Mexico', isoCode: 'MX', validFrom: 1821 });

    expect(res.status).toBe(200);
    expect(res.body.denominationsRestored).toBe(31);
    // The badge the screen draws has to agree with it.
    expect(res.body.denominationCount).toBe(31);

    const live = await queryRows(
      'SELECT 1 FROM Denominations WHERE IssuerId = @id AND IsActive = 1',
      { id }
    );
    expect(live).toHaveLength(31);
    // None left behind: a half-restore is the state nobody can see.
    const dead = await queryRows(
      'SELECT 1 FROM Denominations WHERE IssuerId = @id AND IsActive = 0',
      { id }
    );
    expect(dead).toHaveLength(0);
  });

  it('does NOT re-link the coins the removal unlinked, and leaves their text alone', async () => {
    // The promise the removal made, kept on the way back. The cascade set
    // Coins.DenominationId = NULL and reviving the LABEL does not restore
    // the link — which is also why the objection recorded in
    // denominations.ts ("reactivating would silently re-link coins the user
    // had already decided to detach") cannot apply to this path.
    const mexico = await issuerNamed('Mexico');
    const [denomination] = await queryRows(
      'SELECT DenominationId FROM Denominations WHERE IssuerId = @id ORDER BY SortOrder LIMIT 1',
      { id: Number(mexico['IssuerId']) }
    );
    await insertCoin({
      CoinId: 'revive-1',
      Denomination: '8 Reales',
      DenominationId: Number(denomination['DenominationId']),
    });

    await removeIssuerNamed('Mexico');
    const res = await request(app).post('/api/issuers').send({ name: 'Mexico', isoCode: 'MX', validFrom: 1821 });
    expect(res.status).toBe(200);

    const [coin] = await queryRows(
      "SELECT Denomination, DenominationId FROM Coins WHERE CoinId = 'revive-1'"
    );
    expect(coin['DenominationId']).toBeNull();
    // The user's own record of what the coin says, untouched throughout.
    expect(coin['Denomination']).toBe('8 Reales');

    // So the revived issuer reports no coins, truthfully.
    expect(res.body.coinCount).toBe(0);
  });

  it('applies the fields the user just submitted, keeping the id and the slot', async () => {
    const mexico = await issuerNamed('Mexico');
    const id = Number(mexico['IssuerId']);
    const sortOrder = Number(mexico['SortOrder']);
    await request(app).delete(`/api/issuers/${id}`);

    // Different ISO code and a closed year span: what they typed now is
    // their current answer, not what the row held when it was removed.
    const res = await request(app)
      .post('/api/issuers')
      .send({ name: 'Mexico', isoCode: 'mx', validFrom: 1821, validTo: 1863 });

    expect(res.status).toBe(200);
    const [stored] = await queryRows('SELECT * FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['IsoCode']).toBe('MX');
    expect(stored['ValidFrom']).toBe(1821);
    expect(stored['ValidTo']).toBe(1863);
    // DERIVED from the new span, like every other write.
    expect(stored['Kind']).toBe('historical');
    // SortOrder is the row's own slot and was never the problem.
    expect(Number(stored['SortOrder'])).toBe(sortOrder);
  });

  it('does NOT rewrite British Colonial when it is revived without years', async () => {
    // The same fallback PUT needs, on the same row, for the same reason:
    // there IS a row, so its own Kind is the honest answer for a span that
    // says nothing. Without it the revival silently reclassifies it.
    const { id } = await removeIssuerNamed('British Colonial');
    const [before] = await queryRows('SELECT Kind FROM Issuers WHERE IssuerId = @id', { id });
    expect(before['Kind']).toBe('historical');

    const res = await request(app).post('/api/issuers').send({ name: 'British Colonial' });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('historical');
    const [stored] = await queryRows('SELECT Kind FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Kind']).toBe('historical');
  });

  it('revives on a differently-cased and padded name, because the row would collide anyway', async () => {
    const { id } = await removeIssuerNamed('Mexico');

    const res = await request(app).post('/api/issuers').send({ name: '  mexico  ' });

    expect(res.status).toBe(200);
    expect(res.body.issuerId).toBe(id);
    // The name the user typed now wins — this is also how the screen
    // corrects the casing of a row it could previously only delete.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('mexico');
  });

  it('reports a revival with no denominations as a revival, and zero', async () => {
    // The zero is a different sentence on the screen and a different
    // decision about the online lookup, so it has to be distinguishable
    // from "31 came back" in the body rather than only in the wording.
    const created = await request(app).post('/api/issuers').send({ name: 'Burma', isoCode: 'MM' });
    const id = created.body.issuerId;
    await request(app).delete(`/api/issuers/${id}`);

    const res = await request(app).post('/api/issuers').send({ name: 'Burma', isoCode: 'MM' });

    expect(res.status).toBe(200);
    expect(res.body.issuerId).toBe(id);
    expect(res.body.revived).toBe(true);
    expect(res.body.denominationsRestored).toBe(0);
    expect(res.body.denominationCount).toBe(0);
  });

  it('STILL refuses an ACTIVE duplicate, with 409 and no revival flag', async () => {
    // The half of the old behaviour that was always right. Two live issuers
    // called Mexico must stay impossible: the seed matches BY NAME and a
    // second one makes its join multiply rows instead of failing.
    const res = await request(app).post('/api/issuers').send({ name: ' mexico ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mexico');
    expect(res.body.revived).toBeUndefined();
    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Mexico'")).toHaveLength(1);
  });

  it('prefers the ACTIVE row when a deactivated one also matches the folded name', async () => {
    // UQ_Issuers_Name folds CASE but not WHITESPACE, so 'Mexico ' and
    // 'Mexico' really can both be rows while the route's own comparison
    // treats them as one name. If the deactivated one won, adding an issuer
    // whose name a LIVE issuer already holds would revive the dead one and
    // leave two live issuers answering to the same name.
    await withTestDb((database) => {
      database
        .prepare(
          'INSERT INTO Issuers (Name, Kind, SortOrder, IsActive) ' +
            "VALUES ('Mexico ', 'modern', 9999, 0)"
        )
        .run();
    });

    const res = await request(app).post('/api/issuers').send({ name: 'Mexico' });

    expect(res.status).toBe(409);
    // The dead near-miss stayed dead.
    const [padded] = await queryRows("SELECT IsActive FROM Issuers WHERE Name = 'Mexico '");
    expect(padded['IsActive']).toBe(0);
  });

  it('creates a genuinely new issuer with 201 and no revival flag', async () => {
    // The revival path must not have quietly swallowed the creation path.
    const res = await request(app).post('/api/issuers').send({ name: 'Nowhereland' });

    expect(res.status).toBe(201);
    expect(res.body.revived).toBeUndefined();
    expect(res.body.denominationsRestored).toBeUndefined();
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(71);
  });

  it('leaves another issuer untouched while one is revived', async () => {
    await removeIssuerNamed('Mexico');
    const [before] = await queryRows(
      "SELECT COUNT(*) AS Live FROM Denominations d JOIN Issuers i ON i.IssuerId = d.IssuerId " +
        "WHERE i.Name = 'France' AND d.IsActive = 1"
    );

    await request(app).post('/api/issuers').send({ name: 'Mexico' });

    const [after] = await queryRows(
      "SELECT COUNT(*) AS Live FROM Denominations d JOIN Issuers i ON i.IssuerId = d.IssuerId " +
        "WHERE i.Name = 'France' AND d.IsActive = 1"
    );
    expect(Number(after['Live'])).toBe(Number(before['Live']));
  });
});

describe('PUT /api/issuers/:id — renaming onto a removed name', () => {
  it('refuses, and says the name belongs to a REMOVED issuer rather than an existing one', async () => {
    // It has to refuse: letting the UPDATE through would hit
    // UQ_Issuers_Name and turn a 409 into a 500 with SQL in it. Renaming is
    // also the wrong instrument — merging this issuer into a removed one
    // would abandon this issuer's own denominations. Only the wording
    // changed, because "already an issuer" is baffling when the issuer is
    // nowhere on the screen.
    const mexico = await issuerNamed('Mexico');
    await request(app).delete(`/api/issuers/${Number(mexico['IssuerId'])}`);

    const france = await issuerNamed('France');
    const res = await request(app)
      .put(`/api/issuers/${Number(france['IssuerId'])}`)
      .send({ name: 'Mexico' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('removed issuer');

    // Neither row moved.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', {
      id: Number(france['IssuerId']),
    });
    expect(stored['Name']).toBe('France');
  });
});
