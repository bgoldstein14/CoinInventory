/**
 * routes/lookups/issuers.spec.ts — the Issuers reference table.
 *
 * Issuers became maintainable when the maintenance screen was rebuilt: the
 * seed covers 61 of them and a collector who buys one Burmese coin needs a
 * 62nd without waiting for a release.
 *
 * Three things here are not shared with the other lookup routes, and each
 * has its own test below:
 *
 *   * GET carries the counts the screen needs to say "23 denominations, 7
 *     coins" BEFORE the user presses Remove.
 *   * POST refuses a duplicate name itself rather than letting
 *     UQ_Issuers_Name turn into a 500 with SQL in the message.
 *   * DELETE refuses while denominations still point at the issuer. It is a
 *     SOFT delete, so FK_Denominations_Issuer will not catch that for us.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import { capturedInputs, mockRequest, resetMssqlMock } from '../../test-support/mssql-mock';
import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

/** The SQL text of the nth query the route ran. */
function queryText(call = 0): string {
  return String(mockRequest.query.mock.calls[call]?.[0] ?? '');
}

describe('GET /api/issuers', () => {
  it('returns the maintenance shape, counts included', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        {
          IssuerId: 7,
          Name: 'Mexico',
          IsoCode: 'MX',
          Kind: 'modern',
          ValidFrom: 1821,
          ValidTo: null,
          SortOrder: 10,
          DenominationCount: 23,
          CoinCount: 4,
        },
      ],
    });

    const res = await request(app).get('/api/issuers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        issuerId: 7,
        name: 'Mexico',
        isoCode: 'MX',
        kind: 'modern',
        validFrom: 1821,
        validTo: null,
        sortOrder: 10,
        denominationCount: 23,
        coinCount: 4,
        isActive: true,
      },
    ]);
  });

  it('keeps a null ISO code null instead of inventing an empty string', async () => {
    // Half this table has no ISO code and never will — every ancient and
    // most historical states. '' would render as a blank two-letter box that
    // looks like missing data rather than an absent concept.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        {
          IssuerId: 9,
          Name: 'Roman Empire',
          IsoCode: null,
          Kind: 'ancient',
          ValidFrom: -27,
          ValidTo: 476,
          SortOrder: 90,
          DenominationCount: 0,
          CoinCount: 0,
        },
      ],
    });

    const res = await request(app).get('/api/issuers');
    expect(res.body[0].isoCode).toBeNull();
    expect(res.body[0].validFrom).toBe(-27);
  });

  it('counts denominations and coins without dropping an issuer that has neither', async () => {
    // A LEFT JOIN, not an INNER one: a newly added Burma has no
    // denominations and must still appear, or the user cannot add any.
    await request(app).get('/api/issuers');
    expect(queryText()).toMatch(/LEFT JOIN/i);
    expect(queryText()).not.toMatch(/INNER JOIN/i);
  });

  it('returns only active issuers', async () => {
    await request(app).get('/api/issuers');
    expect(queryText()).toMatch(/i\.IsActive\s*=\s*1/i);
  });
});

describe('POST /api/issuers', () => {
  it('refuses a missing name', async () => {
    const res = await request(app).post('/api/issuers').send({ kind: 'modern' });
    expect(res.status).toBe(400);
    expect(mockRequest.query).not.toHaveBeenCalled();
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
    expect(mockRequest.query).not.toHaveBeenCalled();
  });

  it('refuses an ISO code that is not exactly two letters', async () => {
    // IsoCode is CHAR(2): 'MMR' is TRUNCATED and 'M' is PADDED, both
    // silently, and the padded one then compares unequal to 'M' everywhere.
    for (const isoCode of ['M', 'MMR', '1M']) {
      resetMssqlMock();
      const res = await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern', isoCode });
      expect(res.status, `expected ${isoCode} to be refused`).toBe(400);
    }
  });

  it('refuses a duplicate name with a 409 instead of a SQL error', async () => {
    // UQ_Issuers_Name. Letting the constraint fire returns a 500 carrying a
    // SQL Server message, and the seed script matches issuers BY NAME, so a
    // second 'Mexico' makes its join multiply rows rather than fail.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Name: 'Mexico' }] });

    const res = await request(app).post('/api/issuers').send({ name: ' mexico ', kind: 'modern' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Mexico');
  });

  it('creates an issuer and returns it with its new id', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ IssuerId: 62, SortOrder: 1000 }] });

    const res = await request(app)
      .post('/api/issuers')
      .send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm', validFrom: 1948, validTo: 1989 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      issuerId: 62,
      name: 'Burma',
      isoCode: 'MM',
      kind: 'modern',
      validFrom: 1948,
      validTo: 1989,
      denominationCount: 0,
      coinCount: 0,
      isActive: true,
    });
  });

  it('trims the name and upper-cases the ISO code before binding them', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ IssuerId: 62, SortOrder: 1000 }] });

    await request(app).post('/api/issuers').send({ name: '  Burma  ', kind: 'modern', isoCode: 'mm' });

    const bound = Object.fromEntries(capturedInputs.map((input) => [input.name, input.value]));
    expect(bound['name']).toBe('Burma');
    expect(bound['isoCode']).toBe('MM');
  });

  it('accepts a BC year as a negative number', async () => {
    // The Roman Republic starts at -509. A route that rejected negatives
    // would exclude the entries the design calls first-class.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ IssuerId: 63, SortOrder: 1010 }] });

    const res = await request(app)
      .post('/api/issuers')
      .send({ name: 'Roman Republic', kind: 'ancient', validFrom: -509, validTo: -27 });

    expect(res.status).toBe(201);
    expect(res.body.validFrom).toBe(-509);
  });

  it('puts a new issuer at the end of the order, computed in SQL', async () => {
    // Computed server-side so two tabs cannot both claim the same slot, and
    // at the END so a user's addition does not jump above the seeded list.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [{ IssuerId: 62, SortOrder: 1000 }] });

    await request(app).post('/api/issuers').send({ name: 'Burma', kind: 'modern' });
    expect(queryText(1)).toMatch(/MAX\(SortOrder\)/i);
  });
});

describe('PUT /api/issuers/:id', () => {
  it('updates an issuer in place, keeping its id', async () => {
    // Rename in place, exactly like catalogues: denominations reference the
    // issuer BY ID, so remove-and-re-add would orphan all of them.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/issuers/7')
      .send({ name: 'Mexico (Republic)', kind: 'modern', isoCode: 'MX' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issuerId: 7, name: 'Mexico (Republic)' });
  });

  it('allows an issuer to keep its own name', async () => {
    // The duplicate check must exclude the row being edited, or changing
    // only the dates would fail with "that name is taken" by itself.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app).put('/api/issuers/7').send({ name: 'Mexico', kind: 'modern' });
    expect(res.status).toBe(200);
    expect(String(mockRequest.query.mock.calls[0][0])).toMatch(/IssuerId\s*<>\s*@id/i);
  });

  it('404s for an id that is not there', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).put('/api/issuers/999').send({ name: 'Nowhere', kind: 'modern' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/issuers/:id', () => {
  it('refuses while denominations are still filed under it', async () => {
    // THE BUG THIS PREVENTS: the delete is SOFT, so
    // FK_Denominations_Issuer does not fire. Twenty-three denominations
    // would keep their IssuerId, the issuer would stop being returned, and
    // all twenty-three would silently appear under "No issuer yet" — spread
    // through a list of 1,161 with no way to undo it in one step.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ DenominationCount: 23 }] });

    const res = await request(app).delete('/api/issuers/7');
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('23');
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });

  it('soft-deletes an issuer that has none', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ DenominationCount: 0 }] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app).delete('/api/issuers/62');
    expect(res.status).toBe(204);
    expect(queryText(1)).toMatch(/SET\s+IsActive\s*=\s*0/i);
    expect(queryText(1)).not.toMatch(/\bDELETE\b/i);
  });

  it('404s for an id that is not there', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ DenominationCount: 0 }] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/issuers/999');
    expect(res.status).toBe(404);
  });
});
