/**
 * HTTP tests for /api/catalogs against the in-memory database (15 seeded
 * catalogues). Checks the CatalogOption wire shape, active rows in seeded
 * order, a 400 for a missing name, and that DELETE is soft (foreign keys are
 * enforced, so the test attributes a coin first and checks it survives).
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

// Most tests change seeded Catalogs rows, which the per-test reset leaves alone.
beforeEach(async () => {
  await rebuildTestDatabase();
});

describe('GET /api/catalogs', () => {
  it('returns the frontend-compatible catalogue shape', async () => {
    const res = await request(app).get('/api/catalogs');
    expect(res.status).toBe(200);
    // The fifteen seeded catalogues, in picker order.
    expect(res.body).toHaveLength(15);
    expect(res.body[0]).toEqual({ catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true });
    expect(res.body[2]).toEqual({ catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true });
  });

  it('returns every catalogue in SortOrder, flagging removed ones inactive', async () => {
    // Seeded order, not alphabetical (Sear first).
    const names: string[] = (await request(app).get('/api/catalogs')).body.map(
      (catalog: { name: string }) => catalog.name
    );
    expect(names[0]).toBe('Sear');
    expect(names).not.toEqual([...names].sort());

    // A soft-deleted catalogue is still returned, so coins using it keep their name;
    // the client hides it from the picker.
    await withTestDb((database) => {
      database.exec("UPDATE Catalogs SET IsActive = 0 WHERE Name = 'Sear'");
    });

    const after = await request(app).get('/api/catalogs');
    expect(after.body).toHaveLength(15);
    expect(after.body[0]).toMatchObject({ name: 'Sear', isActive: false });
    expect(after.body[1]).toMatchObject({ name: 'RIC', isActive: true });
  });

  it('returns exactly what the database returned, with no static list merged in', async () => {
    // Regression guard: the response must be the database rows only, with no
    // merged static list. Narrowed to one row so the equality is exact.
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
    // Otherwise the picker gets a blank entry.
    const res = await request(app).post('/api/catalogs').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(await queryRows('SELECT 1 FROM Catalogs')).toHaveLength(15);
  });

  it('creates a catalogue and returns it with its new id', async () => {
    // Fifteen seeded rows, so this is 16.
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
    // New entries go after the seeded 1..15.
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
    // Renamed in place: coins reference the row by id.
    await insertCoin({ CoinId: 'ric-coin', CatalogId: 2, CatalogNumber: 'II.1 234' });

    const res = await request(app)
      .put('/api/catalogs/2')
      .send({ name: 'RIC (Roman Imperial Coinage)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ catalogId: 2, name: 'RIC (Roman Imperial Coinage)' });

    // Still 15 rows: renamed, not re-added.
    expect(await queryRows('SELECT 1 FROM Catalogs')).toHaveLength(15);
    const [stored] = await queryRows('SELECT Name FROM Catalogs WHERE CatalogId = 2');
    expect(stored['Name']).toBe('RIC (Roman Imperial Coinage)');
    const [coin] = await queryRows("SELECT CatalogId FROM CoinCatalogRefs WHERE CoinId = 'ric-coin'");
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
    // Soft delete. With foreign keys on, a hard delete of a catalogue in use
    // would fail with a 409; the coin must be untouched.
    await insertCoin({ CoinId: 'rpc-coin', CatalogId: 4, CatalogNumber: '1234' });

    const res = await request(app).delete('/api/catalogs/4');
    expect(res.status).toBe(204);

    const [catalog] = await queryRows('SELECT Name, IsActive FROM Catalogs WHERE CatalogId = 4');
    expect(catalog).toBeDefined();
    expect(catalog['IsActive']).toBe(0);

    const [coin] = await queryRows("SELECT CatalogId, CatalogNumber FROM CoinCatalogRefs WHERE CoinId = 'rpc-coin'");
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
