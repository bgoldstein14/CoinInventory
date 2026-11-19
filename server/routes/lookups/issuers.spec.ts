/**
 * The Issuers routes, against the in-memory database seeded with the real 70
 * issuers. Covers what differs from other lookups: GET includes counts, POST
 * refuses (or revives) duplicate names itself, and DELETE cascades to
 * denominations and coins in one transaction.
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

// Most tests change seeded Issuers rows, which the per-test reset leaves
// alone, so rebuild to restore the 70.
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
    // Four coins on one denomination: COUNT(DISTINCT) must survive the join multiplying rows.
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
    // The seed's denominations under Mexico.
      denominationCount: 31,
      coinCount: 4,
      isActive: true,
    });
  });

  it('keeps a null ISO code null instead of inventing an empty string', async () => {
    // Many issuers have no ISO code; null rather than ''.
    const res = await request(app).get('/api/issuers');

    const romanEmpire = res.body.find((issuer: { name: string }) => issuer.name === 'Roman Empire');
    expect(romanEmpire.isoCode).toBeNull();
    expect(romanEmpire.validFrom).toBe(-27);
  });

  it('counts denominations and coins without dropping an issuer that has neither', async () => {
    // A LEFT JOIN: an issuer with no denominations must still appear, with zeroes.
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
    // The other 69 are still there.
    expect(res.body).toHaveLength(69);
  });

  it('orders them alphabetically by name, not by SortOrder', async () => {
    // Alphabetical, not the seed's curator SortOrder.
    const res = await request(app).get('/api/issuers');
    const names: string[] = res.body.map((issuer: { name: string }) => issuer.name);

    // Case-insensitive (Name is COLLATE NOCASE).
    const alphabetical = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(alphabetical);

    // Not the curator order, which would start with the United States.
    expect(names[0]).toBe('Achaemenid Persia');
    const sortOrders: number[] = res.body.map((issuer: { sortOrder: number }) => issuer.sortOrder);
    expect(sortOrders).not.toEqual([...sortOrders].sort((a, b) => a - b));
  });

  it('breaks a name tie on the id so the order is total', async () => {
    // Needs a tie-breaker for a stable order. Asserted on the ORDER BY text
    // because NOCASE uniqueness makes a tie impossible to create.
    await request(app).get('/api/issuers');

    const sql = findQuery(/FROM Issuers i/)?.sql ?? '';
    const clause = /ORDER BY([^\n]*)/i.exec(sql)?.[1] ?? '';
    expect(clause).toMatch(/i\.Name\s*,\s*i\.IssuerId/i);
    expect(clause).not.toMatch(/SortOrder/i);
  });

  it('still SELECTs SortOrder, because the client still carries it', async () => {
    // SortOrder is still selected: IssuerRecord requires it.
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
    // Kind has no CHECK constraint, so the route must reject unknown values.
    const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'imaginary' });
    expect(res.status).toBe(400);
    expect(executedSql()).toEqual([]);
  });

  it('refuses an ISO code that is not exactly two letters', async () => {
    // IsoCode must be exactly two letters.
    for (const isoCode of ['M', 'MMR', '1M']) {
      const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern', isoCode });
      expect(res.status, `expected ${isoCode} to be refused`).toBe(400);
    }

    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Burma'")).toEqual([]);
  });

  it('refuses a duplicate name with a 409 instead of a SQL error', async () => {
    // Refused by the route rather than surfacing UQ_Issuers_Name as a 500.
    const res = await request(app).post('/api/issuers').send({ name: ' mexico ', kind: 'modern' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mexico');

    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Mexico'")).toHaveLength(1);
  });

  it('creates an issuer and returns it with its new id', async () => {
    // The body says 'modern' but the stored Kind is 'historical': it is
    // derived from the years, and 1948-1989 has an end year.
    const res = await request(app)
      .post('/api/issuers')
      .send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm', validFrom: 1948, validTo: 1989 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      // 70 seeded rows, so this is 71.
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
    // The three branches, with no `kind` in the body (as the form sends).
    const cases = [
      { name: 'Miletos', validFrom: -600, validTo: -400, kind: 'ancient' },
      { name: 'Kingdom of Westphalia', validFrom: 1807, validTo: 1813, kind: 'historical' },
      { name: 'Namibia', validFrom: 1990, kind: 'modern' },
      // No years: modern.
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
    // Ancient is checked before historical (e.g. a span ending before ~1500).
    const res = await request(app).post('/api/issuers').send({ name: 'Kingdom of Axum', validFrom: 270, validTo: 960 });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('ancient');
  });

  it('trims the name and upper-cases the ISO code before binding them', async () => {
    await request(app).post('/api/issuers').send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm' });

    // Check the stored row is trimmed.
    const [stored] = await queryRows("SELECT Name, IsoCode FROM Issuers WHERE Kind = 'modern' AND IssuerId = 71");
    expect(stored['Name']).toBe('Burma');
    expect(stored['IsoCode']).toBe('MM');
  });

  it('accepts a BC year as a negative number', async () => {
    // Negative years are valid. (Uses a name the seed doesn't have.)
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
    // Computed server-side, after the seeded rows (highest is 3070).
    const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern' });

    expect(res.status).toBe(201);
    expect(res.body.sortOrder).toBe(3080);

    const [{ MaxSortOrder: highest }] = await queryRows('SELECT MAX(SortOrder) AS MaxSortOrder FROM Issuers');
    expect(highest).toBe(3080);
  });
});

describe('PUT /api/issuers/:id', () => {
  it('updates an issuer in place, keeping its id', async () => {
    // Renamed in place: denominations reference the issuer by id.
    const mexico = await issuerNamed('Mexico');
    const id = Number(mexico['IssuerId']);

    const res = await request(app)
      .put(`/api/issuers/${id}`)
      .send({ name: 'Mexico (Republic)', kind: 'modern', isoCode: 'MX' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issuerId: id, name: 'Mexico (Republic)' });

    // Same row, new name.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('Mexico (Republic)');
    expect(await queryRows('SELECT 1 FROM Denominations WHERE IssuerId = @id', { id })).toHaveLength(31);
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
  });

  it('allows an issuer to keep its own name', async () => {
    // The duplicate check excludes the row being edited.
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
    // British Colonial has no dates and is curated 'historical'. Editing its
    // name (no `kind` sent) must keep that, which requires reading the row.
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
    // The stored kind is only a fallback: once it has a span, the span decides.
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
 * DELETE cascades: the issuer's denominations are deactivated and their
 * coins unlinked in the same transaction.
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

    // No denominations left active under the removed issuer.
    expect(await activeDenominationIds(id)).toEqual([]);
  });

  it('unlinks the affected coins and leaves their recorded text alone', async () => {
    // The coin keeps its Denomination text; only the id link is cleared.
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

    // Soft delete: the row is still there.
    const [stored] = await queryRows('SELECT IsActive FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored).toBeDefined();
    expect(stored['IsActive']).toBe(0);
  });

  it('404s for an id that is not there, and rolls the transaction back', async () => {
    const res = await request(app).delete('/api/issuers/999');
    expect(res.status).toBe(404);
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
    // Nothing was committed on the way to the 404.
    const [{ Live: live }] = await queryRows(
      'SELECT COUNT(*) AS Live FROM Denominations WHERE IsActive = 0'
    );
    expect(Number(live)).toBe(0);
  });
});

/*
 * Re-adding a removed issuer. The soft-deleted row still holds the name, and
 * filtering the duplicate check on IsActive = 1 isn't the fix: the INSERT would
 * then hit UQ_Issuers_Name. POST revives the old row instead.
 */
describe('POST /api/issuers — reviving a removed one', () => {
  /** Removes an issuer as the screen does and reports what went with it. */
  async function removeIssuerNamed(name: string): Promise<{ id: number; denominationsRemoved: number }> {
    const row = await issuerNamed(name);
    const id = Number(row['IssuerId']);
    const res = await request(app).delete(`/api/issuers/${id}`);
    expect(res.status).toBe(200);
    return { id, denominationsRemoved: Number(res.body.denominationsRemoved) };
  }

  it('THE TRAP, HALF ONE: the removed row still holds the name', async () => {
    // The premise: a soft delete leaves the row and its name.
    const { id } = await removeIssuerNamed('Mexico');

    const [stored] = await queryRows('SELECT Name, IsActive FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('Mexico');
    expect(stored['IsActive']).toBe(0);

    // ...and the screen can't see it, so the form can't warn.
    const list = await request(app).get('/api/issuers');
    expect(list.body.some((issuer: { name: string }) => issuer.name === 'Mexico')).toBe(false);
  });

  it('THE TRAP, HALF TWO: UQ_Issuers_Name would fire if the insert were let through', async () => {
    // Why `AND IsActive = 1` isn't the fix, against the real constraint.
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
    // The constraint is case-insensitive too.
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
    // The revived row keeps its id, so references to it still work.
    const { id } = await removeIssuerNamed('Mexico');

    const res = await request(app).post('/api/issuers').send({ name: 'Mexico', isoCode: 'MX', validFrom: 1821 });

    expect(res.status).toBe(200);
    expect(res.body.issuerId).toBe(id);
    expect(res.body.revived).toBe(true);

    // One row called Mexico: the original.
    const rows = await queryRows("SELECT IssuerId, IsActive FROM Issuers WHERE Name = 'Mexico'");
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]['IssuerId'])).toBe(id);
    expect(rows[0]['IsActive']).toBe(1);

    // Nothing inserted.
    expect(await queryRows('SELECT 1 FROM Issuers')).toHaveLength(70);
  });

  it('BRINGS THE DENOMINATIONS BACK, still filed under the same issuer id', async () => {
    // Its denominations come back too (they were removed by the cascade).
    const { id, denominationsRemoved } = await removeIssuerNamed('Mexico');
    expect(denominationsRemoved).toBe(31);

    const res = await request(app).post('/api/issuers').send({ name: 'Mexico', isoCode: 'MX', validFrom: 1821 });

    expect(res.status).toBe(200);
    expect(res.body.denominationsRestored).toBe(31);
    // The count in the response agrees.
    expect(res.body.denominationCount).toBe(31);

    const live = await queryRows(
      'SELECT 1 FROM Denominations WHERE IssuerId = @id AND IsActive = 1',
      { id }
    );
    expect(live).toHaveLength(31);
    // None left inactive.
    const dead = await queryRows(
      'SELECT 1 FROM Denominations WHERE IssuerId = @id AND IsActive = 0',
      { id }
    );
    expect(dead).toHaveLength(0);
  });

  it('does NOT re-link the coins the removal unlinked, and leaves their text alone', async () => {
    // Coin links are not restored: the cascade nulled them.
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
    // The coin's recorded text is untouched.
    expect(coin['Denomination']).toBe('8 Reales');

    // So the revived issuer reports no coins.
    expect(res.body.coinCount).toBe(0);
  });

  it('applies the fields the user just submitted, keeping the id and the slot', async () => {
    const mexico = await issuerNamed('Mexico');
    const id = Number(mexico['IssuerId']);
    const sortOrder = Number(mexico['SortOrder']);
    await request(app).delete(`/api/issuers/${id}`);

    // The submitted values replace the old ones.
    const res = await request(app)
      .post('/api/issuers')
      .send({ name: 'Mexico', isoCode: 'mx', validFrom: 1821, validTo: 1863 });

    expect(res.status).toBe(200);
    const [stored] = await queryRows('SELECT * FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['IsoCode']).toBe('MX');
    expect(stored['ValidFrom']).toBe(1821);
    expect(stored['ValidTo']).toBe(1863);
    // Derived from the new span.
    expect(stored['Kind']).toBe('historical');
    // SortOrder keeps the row's slot.
    expect(Number(stored['SortOrder'])).toBe(sortOrder);
  });

  it('does NOT rewrite British Colonial when it is revived without years', async () => {
    // Like PUT, an undated revival falls back to the row's own Kind.
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
    // The submitted name (including its casing) wins.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', { id });
    expect(stored['Name']).toBe('mexico');
  });

  it('reports a revival with no denominations as a revival, and zero', async () => {
    // "Zero restored" must be distinguishable in the body.
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
    // An active duplicate is still refused.
    const res = await request(app).post('/api/issuers').send({ name: ' mexico ' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mexico');
    expect(res.body.revived).toBeUndefined();
    expect(await queryRows("SELECT * FROM Issuers WHERE Name = 'Mexico'")).toHaveLength(1);
  });

  it('prefers the ACTIVE row when a deactivated one also matches the folded name', async () => {
    // The unique constraint folds case but not whitespace, so 'Mexico ' and
    // 'Mexico' can both exist. The active row must win the match, or a live
    // name could revive a dead near-duplicate.
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
    // Ordinary creation still works.
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
    // PUT still refuses a deactivated name (the UPDATE would hit the unique
    // constraint); only the message is clearer.
    const mexico = await issuerNamed('Mexico');
    await request(app).delete(`/api/issuers/${Number(mexico['IssuerId'])}`);

    const france = await issuerNamed('France');
    const res = await request(app)
      .put(`/api/issuers/${Number(france['IssuerId'])}`)
      .send({ name: 'Mexico' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('removed issuer');

    // Neither row changed.
    const [stored] = await queryRows('SELECT Name FROM Issuers WHERE IssuerId = @id', {
      id: Number(france['IssuerId']),
    });
    expect(stored['Name']).toBe('France');
  });
});
