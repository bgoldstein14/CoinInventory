/**
 * routes/lookups/reference-usage.spec.ts — "how many coins use this?"
 *
 * A visible in-use count per entry means the consequence
 * of removing something is known BEFORE the confirmation appears. Delete then
 * requires the denomination delete to null those coins' DenominationId.
 *
 * Both are tested here together on purpose: the number the screen shows and
 * the number of rows the delete touches have to be the same number, and the
 * only way to guarantee that is for both to come out of the same column of
 * the same table. A count derived from Coins.Denomination TEXT while the
 * delete unlinks Coins.DenominationId would be two different questions
 * wearing one label.
 *
 * *** THE COUNTS BELOW ARE COUNTED, NOT QUEUED. *** The coins are inserted
 * into the real in-memory SQLite database and the six GROUP BYs really run
 * over them, so "counts the DenominationId column, not the Denomination
 * text" is now proved by giving a coin a denomination TEXT that must not be
 * counted — rather than by looking for the column's name in the SQL.
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

// The DELETE tests deactivate a seeded Denominations row and the POST tests
// add one; both are reference data the ordinary per-test reset leaves alone.
beforeEach(async () => {
  await rebuildTestDatabase();
});

/** The seeded denomination's real id — AUTOINCREMENT picked it, not the seed file. */
async function denominationId(issuer: string, label: string): Promise<number> {
  const rows = await queryRows(
    'SELECT d.DenominationId FROM Denominations d JOIN Issuers i ON i.IssuerId = d.IssuerId ' +
      'WHERE i.Name = @issuer AND d.Label = @label',
    { issuer, label }
  );
  expect(rows, `no seeded denomination "${label}" under ${issuer}`).toHaveLength(1);
  return Number(rows[0]['DenominationId']);
}

async function catalogId(name: string): Promise<number> {
  const rows = await queryRows('SELECT CatalogId FROM Catalogs WHERE Name = @name', { name });
  expect(rows, `no seeded catalogue called ${name}`).toHaveLength(1);
  return Number(rows[0]['CatalogId']);
}

/**
 * The coins the six GROUP BYs are counted from.
 *
 * One fixture rather than six, because that is the real shape of the
 * problem: every one of these counts comes off the SAME Coins rows, so a
 * coin contributing to the category index contributes to the mint-mark
 * index too.
 */
async function arrangeUsage(): Promise<{
  reales: number;
  cent: number;
  sear: number;
  ric: number;
}> {
  const reales = await denominationId('Mexico', '8 Reales');
  const cent = await denominationId('United States', '1¢');
  const sear = await catalogId('Sear');
  const ric = await catalogId('RIC');

  await insertCoin({
    CoinId: 'u-1',
    Category: 'Gold',
    CoinSet: 'Morgan Set',
    DenominationId: reales,
    MintMark: 'D',
    CatalogId: sear,
    MetalContent: 'Silver',
  });
  await insertCoin({ CoinId: 'u-2', Category: 'Gold', DenominationId: reales, MetalContent: 'Silver' });
  await insertCoin({ CoinId: 'u-3', Category: 'Silver', MintMark: 'D', MetalContent: 'Gold' });
  await insertCoin({ CoinId: 'u-4', DenominationId: cent, CatalogId: ric });

  return { reales, cent, sear, ric };
}

describe('GET /api/reference-usage', () => {
  it('returns one count index per reference type', async () => {
    const { reales, cent, sear, ric } = await arrangeUsage();

    const res = await request(app).get('/api/reference-usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      categories: { Gold: 2, Silver: 1 },
      coinSets: { 'Morgan Set': 1 },
      denominations: { [String(reales)]: 2, [String(cent)]: 1 },
      mintMarks: { D: 2 },
      catalogs: { [String(sear)]: 1, [String(ric)]: 1 },
      // Coins.MetalContent is TEXT, like Category — the coin names the metal
      // rather than pointing at a MetalContents row. 'Silver' therefore
      // appears here as a metal (two coins) and in `categories` as a
      // category (one coin), which are two different questions about two
      // different columns.
      metalContents: { Silver: 2, Gold: 1 },
    });
  });

  it('keys denominations and catalogues by id, and the text lookups by text', async () => {
    // Coins reference a denomination and a catalogue BY ID, and a category,
    // set and mint mark BY TEXT. Keying either one the other way produces an
    // index that never matches anything and therefore reports zero for
    // everything — which looks exactly like "nothing is in use".
    // Sorted, because JavaScript reorders integer-like object keys and the
    // order they come back in is neither stable nor meaningful. What matters
    // is WHICH keys exist and that they are strings.
    const { reales, cent, sear, ric } = await arrangeUsage();

    const res = await request(app).get('/api/reference-usage');
    expect(Object.keys(res.body.denominations).sort()).toEqual([String(reales), String(cent)].sort());
    expect(Object.keys(res.body.catalogs).sort()).toEqual([String(sear), String(ric)].sort());
    expect(Object.keys(res.body.mintMarks)).toEqual(['D']);
  });

  it('counts the DenominationId column, not the Denomination text', async () => {
    // Coins.Denomination is what the SOURCE said and is never a link. A
    // count taken from it would key the index by '8 Reales' instead of by
    // the id the screen looks up, and would also count the coin below that
    // has a label and NO link at all.
    const reales = await denominationId('Mexico', '8 Reales');
    await insertCoin({ CoinId: 'd-linked', Denomination: '8 Reales', DenominationId: reales });
    await insertCoin({ CoinId: 'd-unlinked', Denomination: 'Half Dollar', DenominationId: null });

    const res = await request(app).get('/api/reference-usage');
    expect(res.body.denominations).toEqual({ [String(reales)]: 1 });
  });

  it('ignores blank text values instead of offering an unnamed bucket', async () => {
    // Coins.Category is nullable and years of imports have left ''
    // in it. A '' bucket would appear in the screen as a nameless entry with
    // a count beside it.
    await insertCoin({ CoinId: 'b-1', Category: 'Gold' });
    await insertCoin({ CoinId: 'b-2', Category: '' });
    await insertCoin({ CoinId: 'b-3', Category: '   ' });
    await insertCoin({ CoinId: 'b-4', Category: null });

    const res = await request(app).get('/api/reference-usage');
    expect(res.body.categories).toEqual({ Gold: 1 });
  });

  it('answers with empty indexes rather than failing when nothing is recorded', async () => {
    const res = await request(app).get('/api/reference-usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      categories: {},
      coinSets: {},
      denominations: {},
      mintMarks: {},
      catalogs: {},
      metalContents: {},
    });
  });

  it('counts the metal a coin records, ignoring the blanks', async () => {
    // The Metal Content pane shows this beside every entry and the Remove
    // confirmation quotes it, so the same blank-filtering the text lookups
    // already do has to apply: '' and '   ' are what years of imports left
    // behind, and a nameless bucket matches no entry in the list.
    await insertCoin({ CoinId: 'm-1', MetalContent: '90% Silver' });
    await insertCoin({ CoinId: 'm-2', MetalContent: '90% Silver' });
    await insertCoin({ CoinId: 'm-3', MetalContent: '' });
    await insertCoin({ CoinId: 'm-4', MetalContent: '   ' });
    await insertCoin({ CoinId: 'm-5', MetalContent: null });

    const res = await request(app).get('/api/reference-usage');
    expect(res.body.metalContents).toEqual({ '90% Silver': 2 });
  });
});

describe('DELETE /api/denominations/:id — design §4.4', () => {
  it('nulls the DenominationId of every coin using it', async () => {
    // Step 2. Without this the coins keep pointing at a soft-deleted row,
    // which no longer resolves to a label, so they read as unresolved
    // anyway — but by accident, and a reactivation would not bring them
    // back in any predictable state.
    const reales = await denominationId('Mexico', '8 Reales');
    for (const id of ['x-1', 'x-2', 'x-3']) {
      await insertCoin({ CoinId: id, Denomination: '8 Reales', DenominationId: reales });
    }

    const res = await request(app).delete(`/api/denominations/${reales}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ denominationId: reales, coinsUnlinked: 3 });

    const coins = await queryRows('SELECT CoinId, DenominationId FROM Coins ORDER BY CoinId');
    expect(coins.map((coin) => coin['DenominationId'])).toEqual([null, null, null]);
  });

  it('NEVER writes Coins.Denomination', async () => {
    // *** THE ONE RULE THAT MAKES ALL OF THIS RECOVERABLE. ***
    // Coins.Denomination is never written. It is what the
    // source said, it is the only record of what the coin was, and it is
    // what lets the user recognise the row and re-link it afterwards. A
    // DELETE that blanked it would turn a reversible unlink into data loss.
    const reales = await denominationId('Mexico', '8 Reales');
    await insertCoin({ CoinId: 'x-1', Denomination: '8 Reales', DenominationId: reales });

    await request(app).delete(`/api/denominations/${reales}`);

    const [coin] = await queryRows('SELECT Denomination FROM Coins WHERE CoinId = @id', { id: 'x-1' });
    expect(coin['Denomination']).toBe('8 Reales');
  });

  it('soft-deletes the denomination rather than removing the row', async () => {
    const reales = await denominationId('Mexico', '8 Reales');

    await request(app).delete(`/api/denominations/${reales}`);

    // The row is still there, deactivated. A hard DELETE also answers 200
    // and nothing in the response distinguishes the two.
    const [stored] = await queryRows('SELECT IsActive, Label FROM Denominations WHERE DenominationId = @id', {
      id: reales,
    });
    expect(stored).toBeDefined();
    expect(stored['IsActive']).toBe(0);
    expect(stored['Label']).toBe('8 Reales');
  });

  it('unlinks the coins BEFORE deactivating the row', async () => {
    // Order matters and it is not arbitrary. FK_Coins_Denomination means no
    // coin can point at a denomination that does not exist, so unlinking
    // first is always safe; deactivating first would leave a window — and,
    // if the second statement failed, a permanent state — in which coins
    // point at a row the API no longer returns.
    //
    // Order of EXECUTION is the one thing the finished rows cannot show, so
    // this reads the recorded statements rather than the table.
    const reales = await denominationId('Mexico', '8 Reales');
    await insertCoin({ CoinId: 'x-1', DenominationId: reales });

    await request(app).delete(`/api/denominations/${reales}`);

    const statements = executedSql();
    const unlink = statements.findIndex((sql) => /UPDATE\s+Coins/i.test(sql));
    const deactivate = statements.findIndex((sql) => /UPDATE\s+Denominations/i.test(sql));
    expect(unlink).toBeGreaterThanOrEqual(0);
    expect(unlink).toBeLessThan(deactivate);
  });

  it('does both in one transaction, so a failure cannot leave half of it done', async () => {
    // *** THIS USED TO SAY "IN ONE BATCH" AND COULD NOT STAY THAT WAY. ***
    // The T-SQL version was a single four-statement batch carrying the row
    // counts in a @@ROWCOUNT local. SQLite's prepare() compiles the FIRST
    // statement of a multi-statement string and discards the rest silently,
    // so db/sql-api.ts refuses a multi-statement query outright and the
    // route uses an explicit transaction instead. The guarantee is the
    // same — both UPDATEs commit or neither does — so what is asserted is
    // that both ran inside one transaction, not that there was one call.
    const reales = await denominationId('Mexico', '8 Reales');
    await insertCoin({ CoinId: 'x-1', DenominationId: reales });

    await request(app).delete(`/api/denominations/${reales}`);

    expect(findQuery(/UPDATE\s+Coins/i)?.inTransaction).toBe(true);
    expect(findQuery(/UPDATE\s+Denominations/i)?.inTransaction).toBe(true);
    expect(executedSql()).toHaveLength(2);
  });

  it('404s when the denomination was not there, having changed nothing', async () => {
    const res = await request(app).delete('/api/denominations/999999');
    expect(res.status).toBe(404);
    expect(await queryRows('SELECT 1 FROM Denominations WHERE IsActive = 0')).toEqual([]);
  });

  it('reports zero unlinked coins without failing', async () => {
    const unused = await denominationId('United States', '1¢');

    const res = await request(app).delete(`/api/denominations/${unused}`);
    expect(res.status).toBe(200);
    expect(res.body.coinsUnlinked).toBe(0);
  });
});

describe('GET and POST /api/denominations — the issuer link', () => {
  it('returns the issuer id and name so the screen can group by issuer', async () => {
    const reales = await denominationId('Mexico', '8 Reales');

    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);

    const row = res.body.find((d: { denominationId: number }) => d.denominationId === reales);
    expect(row).toMatchObject({
      denominationId: reales,
      label: '8 Reales',
      issuerName: 'Mexico',
      faceValue: 8,
    });
    expect(row.issuerId).toBe(Number((await queryRows("SELECT IssuerId FROM Issuers WHERE Name = 'Mexico'"))[0]['IssuerId']));
  });

  it('keeps a null issuer null rather than dropping the row', async () => {
    // Denominations.IssuerId is nullable through the migration window. A
    // row with no issuer must still reach the screen — it is the only place
    // it can be given one. The LEFT JOIN in the route is what keeps it.
    await withTestDb((database) => {
      database
        .prepare(
          'INSERT INTO Denominations (Label, Country, IssuerId, FaceValue, SortOrder, IsActive) ' +
            "VALUES ('Crown', 'GB', NULL, NULL, 2, 1)"
        )
        .run();
    });

    const res = await request(app).get('/api/denominations');
    // Filtered on the null issuer, not on the label: the seed already files
    // a 'Crown' under Great Britain and under Ireland, and the row this
    // test cares about is the one belonging to nobody.
    const orphans = res.body.filter((d: { issuerId: number | null }) => d.issuerId === null);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].label).toBe('Crown');
    expect(orphans[0].issuerName).toBeNull();
  });

  it('stores the issuer a new denomination was added under', async () => {
    // Adding one requires choosing an issuer. Dropping the id here
    // would file every user-added denomination under "No issuer yet", which
    // is the flat list this rebuild exists to end.
    const burma = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern', isoCode: 'MM' });
    const issuerId = burma.body.issuerId;

    const res = await request(app)
      .post('/api/denominations')
      .send({ label: 'Kyat', country: 'MM', issuerId, sortOrder: 10 });

    expect(res.status).toBe(201);
    expect(res.body.issuerId).toBe(issuerId);

    // The STORED row, not just the echoed response. Asserting only on the
    // body passes even when the INSERT binds null, because the body is
    // built from the parsed request rather than from what went to SQL —
    // verified by mutation: stubbing the binding to null left this test
    // green until this line existed.
    const [stored] = await queryRows('SELECT IssuerId FROM Denominations WHERE DenominationId = @id', {
      id: res.body.denominationId,
    });
    expect(stored['IssuerId']).toBe(issuerId);
  });

  it('binds a null issuer when none was sent, rather than a zero or a NaN', async () => {
    // The older editor add path sends no issuer, and the column is
    // nullable. Binding Number(undefined) would put NaN into an INT
    // parameter — db/bind-values.ts now refuses that outright — and binding
    // 0 would point at an issuer id that does not exist and fail
    // FK_Denominations_Issuer, which SQLite really does enforce here.
    const res = await request(app).post('/api/denominations').send({ label: 'Crown', country: 'GB' });
    expect(res.status).toBe(201);

    const [stored] = await queryRows('SELECT IssuerId FROM Denominations WHERE DenominationId = @id', {
      id: res.body.denominationId,
    });
    expect(stored['IssuerId']).toBeNull();
  });
});
