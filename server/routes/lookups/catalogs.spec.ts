/**
 * routes/lookups/catalogs.spec.ts — HTTP-level tests for /api/catalogs.
 *
 * A separate file from lookups.spec.ts on purpose: that one covers the five
 * reference tables that existed before this change, and several pieces of
 * work are touching it at the same time. The style is identical — drive the
 * real Express app with supertest against the real in-memory SQLite
 * database, which arrives with the fifteen seeded catalogues already in it.
 *
 * WHAT THESE GUARD
 *
 *   - THE SHAPE ON THE WIRE. The Angular side types this as CatalogOption
 *     ({ catalogId, name, sortOrder, isActive }). A route that answered
 *     { CatalogId, Name } would typecheck on neither side and would show an
 *     empty picker with no error anywhere.
 *
 *   - ONLY ACTIVE ROWS, IN SEEDED ORDER. The seed order is the order the
 *     collection actually uses its catalogues, so sorting by name instead
 *     would put BMC first and Sear eleventh. And a soft-deleted catalogue
 *     must not come back into the picker.
 *
 *   - THE DELETE IS SOFT. A hard DELETE would hit FK_Coins_Catalog and fail,
 *     or — worse, if somebody "fixed" that with a cascade — take the user's
 *     coins with it. The route must UPDATE IsActive, never DELETE. That
 *     foreign key is now REALLY ENFORCED (db/driver.ts turns foreign_keys
 *     on), so the delete test attributes a coin first and then checks the
 *     coin is still there afterwards.
 *
 *   - A MISSING NAME IS A 400, not a row called "undefined".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import {
  queryRows,
  insertCoin,
  withTestDb,
  rebuildTestDatabase,
} from '../../test-support/sqlite-test-db';
import { app } from '../../server';

// Catalogs is SEEDED reference data and almost every test here adds to,
// renames or deactivates a row in it; the ordinary per-test reset
// deliberately leaves the reference tables alone.
beforeEach(async () => {
  await rebuildTestDatabase();
});

describe('GET /api/catalogs', () => {
  it('returns the frontend-compatible catalogue shape', async () => {
    const res = await request(app).get('/api/catalogs');
    expect(res.status).toBe(200);
    // The fifteen seeded catalogues, numbered 1..15 in picker order.
    expect(res.body).toHaveLength(15);
    expect(res.body[0]).toEqual({ catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true });
    expect(res.body[2]).toEqual({ catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true });
  });

  it('asks the database for active rows in SortOrder, not alphabetically', async () => {
    // Seeded order is the order this collection uses its catalogues. Sorting
    // by name would open the picker on BMC and bury Sear in eleventh place.
    const names: string[] = (await request(app).get('/api/catalogs')).body.map(
      (catalog: { name: string }) => catalog.name
    );
    expect(names[0]).toBe('Sear');
    expect(names).not.toEqual([...names].sort());

    // And a soft-deleted catalogue leaves the picker.
    await withTestDb((database) => {
      database.exec("UPDATE Catalogs SET IsActive = 0 WHERE Name = 'Sear'");
    });

    const after = await request(app).get('/api/catalogs');
    expect(after.body).toHaveLength(14);
    expect(after.body.map((catalog: { name: string }) => catalog.name)).not.toContain('Sear');
    expect(after.body[0].name).toBe('RIC');
  });

  it('returns exactly what the database returned, with no static list merged in', async () => {
    // The same regression guard denominations and mint marks carry: a
    // hard-coded list merged with the query produced duplicate dropdown
    // entries. The seed lives in the database; this route is a reader.
    //
    // Narrowed to one row, so the equality is exact and readable: if the
    // route still merged a static catalogue list, the other fourteen names
    // would reappear here even though the table no longer has them.
    await withTestDb((database) => {
      database.exec("DELETE FROM Catalogs WHERE Name <> 'Hendin'");
    });

    const res = await request(app).get('/api/catalogs');
    expect(res.body).toEqual([{ catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true }]);
  });
});

describe('POST /api/catalogs', () => {
  it('returns 400 when no name is given', async () => {
    const res = await request(app).post('/api/catalogs').send({});
    expect(res.status).toBe(400);
    expect(await queryRows('SELECT 1 FROM Catalogs')).toHaveLength(15);
  });

  it('returns 400 for a name that is only whitespace', async () => {
    // Otherwise the picker grows a blank entry nobody can identify or
    // remove by name.
    const res = await request(app).post('/api/catalogs').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(await queryRows('SELECT 1 FROM Catalogs')).toHaveLength(15);
  });

  it('creates a catalogue and returns it with its new id', async () => {
    // Fifteen seeded rows, so AUTOINCREMENT hands this one 16.
    const res = await request(app).post('/api/catalogs').send({ name: 'Peus' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ catalogId: 16, name: 'Peus', isActive: true });

    const [stored] = await queryRows('SELECT * FROM Catalogs WHERE CatalogId = 16');
    expect(stored).toMatchObject({ Name: 'Peus', IsActive: 1 });
  });

  it('trims the name', async () => {
    const res = await request(app).post('/api/catalogs').send({ name: '  Peus  ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Peus');

    const [stored] = await queryRows('SELECT Name FROM Catalogs WHERE CatalogId = @id', {
      id: res.body.catalogId,
    });
    expect(stored['Name']).toBe('Peus');
  });

  it('puts a new catalogue at the end of the picker by default', async () => {
    // The seed occupies 1..15 in the order the collection uses them. A new
    // entry with SortOrder 0 would jump to the top, ahead of Sear.
    const res = await request(app).post('/api/catalogs').send({ name: 'Peus' });
    expect(res.body.sortOrder).toBe(16);

    const picker = await request(app).get('/api/catalogs');
    expect(picker.body).toHaveLength(16);
    expect(picker.body[15]).toMatchObject({ name: 'Peus', sortOrder: 16 });
  });
});

describe('PUT /api/catalogs/:id', () => {
  it('returns 400 when no name is given', async () => {
    const res = await request(app).put('/api/catalogs/1').send({});
    expect(res.status).toBe(400);
  });

  it('renames a catalogue, keeping its id', async () => {
    // Keeping the id is the whole point of having rename at all: coins
    // reference the row, so remove-and-re-add would orphan every coin
    // attributed to it.
    await insertCoin({ CoinId: 'ric-coin', CatalogId: 2, CatalogNumber: 'II.1 234' });

    const res = await request(app)
      .put('/api/catalogs/2')
      .send({ name: 'RIC (Roman Imperial Coinage)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ catalogId: 2, name: 'RIC (Roman Imperial Coinage)' });

    // One row renamed in place — not removed and re-added, which would have
    // given it id 16 and left the coin pointing at nothing.
    expect(await queryRows('SELECT 1 FROM Catalogs')).toHaveLength(15);
    const [stored] = await queryRows('SELECT Name FROM Catalogs WHERE CatalogId = 2');
    expect(stored['Name']).toBe('RIC (Roman Imperial Coinage)');
    const [coin] = await queryRows("SELECT CatalogId FROM Coins WHERE CoinId = 'ric-coin'");
    expect(coin['CatalogId']).toBe(2);
  });

  it('returns 404 for a catalogue that is not there', async () => {
    const res = await request(app).put('/api/catalogs/999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
    expect(await queryRows("SELECT 1 FROM Catalogs WHERE Name = 'Nope'")).toEqual([]);
  });
});

describe('DELETE /api/catalogs/:id', () => {
  it('SOFT-deletes, so the coins keep their attribution', async () => {
    // *** THE IMPORTANT TEST IN THIS FILE. ***
    // Coins.CatalogId has a foreign key to this table with no cascade. A
    // hard DELETE would either fail outright or, if somebody "fixed" the
    // constraint with a cascade, delete the user's coins. It must be an
    // UPDATE of IsActive, and the coins must be untouched either way.
    //
    // PRAGMA foreign_keys is ON here, so this is no longer a claim about
    // the SQL text: a hard delete of catalogue 4 with this coin attributed
    // to it would raise SQLITE_CONSTRAINT_FOREIGNKEY and answer 409.
    await insertCoin({ CoinId: 'rpc-coin', CatalogId: 4, CatalogNumber: '1234' });

    const res = await request(app).delete('/api/catalogs/4');
    expect(res.status).toBe(204);

    const [catalog] = await queryRows('SELECT Name, IsActive FROM Catalogs WHERE CatalogId = 4');
    expect(catalog).toBeDefined();
    expect(catalog['IsActive']).toBe(0);

    const [coin] = await queryRows("SELECT CatalogId, CatalogNumber FROM Coins WHERE CoinId = 'rpc-coin'");
    expect(coin).toBeDefined();
    expect(coin['CatalogId']).toBe(4);
    expect(coin['CatalogNumber']).toBe('1234');
  });

  it('returns 404 for a catalogue that is not there', async () => {
    const res = await request(app).delete('/api/catalogs/999');
    expect(res.status).toBe(404);
    expect(await queryRows('SELECT 1 FROM Catalogs WHERE IsActive = 0')).toEqual([]);
  });
});
