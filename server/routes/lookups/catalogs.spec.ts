/**
 * routes/lookups/catalogs.spec.ts — HTTP-level tests for /api/catalogs.
 *
 * A separate file from lookups.spec.ts on purpose: that one covers the five
 * reference tables that existed before this change, and several pieces of
 * work are touching it at the same time. The style is identical — mock the
 * mssql driver, drive the real Express app with supertest.
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
 *     coins with it. The route must UPDATE IsActive, never DELETE.
 *
 *   - A MISSING NAME IS A 400, not a row called "undefined".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

describe('GET /api/catalogs', () => {
  it('returns the frontend-compatible catalogue shape', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { CatalogId: 1, Name: 'Sear', SortOrder: 1 },
        { CatalogId: 3, Name: 'Hendin', SortOrder: 3 },
      ],
    });

    const res = await request(app).get('/api/catalogs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { catalogId: 1, name: 'Sear', sortOrder: 1, isActive: true },
      { catalogId: 3, name: 'Hendin', sortOrder: 3, isActive: true },
    ]);
  });

  it('asks the database for active rows in SortOrder, not alphabetically', async () => {
    // Seeded order is the order this collection uses its catalogues. Sorting
    // by name would open the picker on BMC and bury Sear in eleventh place.
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    await request(app).get('/api/catalogs');

    const sql = String(mockRequest.query.mock.calls[0][0]);
    expect(sql).toContain('WHERE IsActive = 1');
    expect(sql).toContain('ORDER BY SortOrder');
  });

  it('returns exactly what the database returned, with no static list merged in', () => {
    // The same regression guard denominations and mint marks carry: a
    // hard-coded list merged with the query produced duplicate dropdown
    // entries. The seed lives in SQL; this route is a reader.
    return request(app)
      .get('/api/catalogs')
      .then(() => {
        const sql = String(mockRequest.query.mock.calls[0][0]);
        expect(sql).toContain('FROM Catalogs');
      });
  });
});

describe('POST /api/catalogs', () => {
  it('returns 400 when no name is given', async () => {
    const res = await request(app).post('/api/catalogs').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for a name that is only whitespace', async () => {
    // Otherwise the picker grows a blank entry nobody can identify or
    // remove by name.
    const res = await request(app).post('/api/catalogs').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('creates a catalogue and returns it with its new id', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ CatalogId: 16 }], rowsAffected: [1] });

    const res = await request(app).post('/api/catalogs').send({ name: 'Peus' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ catalogId: 16, name: 'Peus', isActive: true });
  });

  it('trims the name', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ CatalogId: 17 }], rowsAffected: [1] });

    const res = await request(app).post('/api/catalogs').send({ name: '  Peus  ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Peus');
  });

  it('puts a new catalogue at the end of the picker by default', async () => {
    // The seed occupies 1..15 in the order the collection uses them. A new
    // entry with SortOrder 0 would jump to the top, ahead of Sear.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ CatalogId: 18 }], rowsAffected: [1] });

    await request(app).post('/api/catalogs').send({ name: 'Peus' });

    const sql = String(mockRequest.query.mock.calls[0][0]);
    expect(sql).toMatch(/COALESCE\(MAX\(SortOrder\), 0\) \+ 1/);
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
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/catalogs/2')
      .send({ name: 'RIC (Roman Imperial Coinage)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ catalogId: 2, name: 'RIC (Roman Imperial Coinage)' });
    expect(String(mockRequest.query.mock.calls[0][0])).toContain('UPDATE Catalogs');
  });

  it('returns 404 for a catalogue that is not there', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).put('/api/catalogs/999').send({ name: 'Nope' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/catalogs/:id', () => {
  it('SOFT-deletes, so the coins keep their attribution', async () => {
    // *** THE IMPORTANT TEST IN THIS FILE. ***
    // Coins.CatalogId has a foreign key to this table with no cascade. A
    // hard DELETE would either fail outright or, if somebody "fixed" the
    // constraint with a cascade, delete the user's coins. It must be an
    // UPDATE of IsActive, and the coins must be untouched either way.
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app).delete('/api/catalogs/4');

    expect(res.status).toBe(204);
    const sql = String(mockRequest.query.mock.calls[0][0]);
    expect(sql).toContain('UPDATE Catalogs SET IsActive = 0');
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).not.toMatch(/Coins/);
  });

  it('returns 404 for a catalogue that is not there', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/catalogs/999');
    expect(res.status).toBe(404);
  });
});
