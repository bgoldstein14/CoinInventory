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

function queryText(call = 0): string {
  return String(mockRequest.query.mock.calls[call]?.[0] ?? '');
}

/** The five GROUP BY answers, in the order the route asks for them. */
function answerAllFive(): void {
  mockRequest.query
    .mockResolvedValueOnce({ recordset: [{ K: 'Gold', C: 5 }, { K: 'Silver', C: 2 }] })
    .mockResolvedValueOnce({ recordset: [{ K: 'Morgan Set', C: 3 }] })
    .mockResolvedValueOnce({ recordset: [{ K: 103, C: 3 }, { K: 1, C: 40 }] })
    .mockResolvedValueOnce({ recordset: [{ K: 'D', C: 11 }] })
    .mockResolvedValueOnce({ recordset: [{ K: 4, C: 6 }] });
}

describe('GET /api/reference-usage', () => {
  it('returns one count index per reference type', async () => {
    answerAllFive();

    const res = await request(app).get('/api/reference-usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      categories: { Gold: 5, Silver: 2 },
      coinSets: { 'Morgan Set': 3 },
      denominations: { '103': 3, '1': 40 },
      mintMarks: { D: 11 },
      catalogs: { '4': 6 },
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
    answerAllFive();
    const res = await request(app).get('/api/reference-usage');
    expect(Object.keys(res.body.denominations).sort()).toEqual(['1', '103']);
    expect(Object.keys(res.body.mintMarks)).toEqual(['D']);
  });

  it('counts the DenominationId column, not the Denomination text', async () => {
    answerAllFive();
    await request(app).get('/api/reference-usage');
    expect(queryText(2)).toMatch(/GROUP BY\s+DenominationId/i);
  });

  it('ignores blank text values instead of offering an unnamed bucket', async () => {
    // Coins.Category is nullable and years of imports have left ''
    // in it. A '' bucket would appear in the screen as a nameless entry with
    // a count beside it.
    answerAllFive();
    await request(app).get('/api/reference-usage');
    expect(queryText(0)).toMatch(/LTRIM\(RTRIM\(Category\)\)\s*<>\s*''/i);
  });

  it('answers with empty indexes rather than failing when nothing is recorded', async () => {
    for (let i = 0; i < 5; i += 1) mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app).get('/api/reference-usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      categories: {},
      coinSets: {},
      denominations: {},
      mintMarks: {},
      catalogs: {},
    });
  });
});

describe('DELETE /api/denominations/:id — design §4.4', () => {
  it('nulls the DenominationId of every coin using it', async () => {
    // Step 2. Without this the coins keep pointing at a soft-deleted row,
    // which no longer resolves to a label, so they read as unresolved
    // anyway — but by accident, and a reactivation would not bring them
    // back in any predictable state.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ Removed: 1, CoinsUnlinked: 3 }],
    });

    const res = await request(app).delete('/api/denominations/103');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ denominationId: 103, coinsUnlinked: 3 });
    expect(queryText()).toMatch(/UPDATE\s+Coins\s+SET\s+DenominationId\s*=\s*NULL/i);
  });

  it('NEVER writes Coins.Denomination', async () => {
    // *** THE ONE RULE THAT MAKES ALL OF THIS RECOVERABLE. ***
    // Coins.Denomination is never written. It is what the
    // source said, it is the only record of what the coin was, and it is
    // what lets the user recognise the row and re-link it afterwards. A
    // DELETE that blanked it would turn a reversible unlink into data loss.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 1, CoinsUnlinked: 3 }] });

    await request(app).delete('/api/denominations/103');
    expect(queryText()).not.toMatch(/SET[^;]*\bDenomination\s*=/i);
  });

  it('soft-deletes the denomination rather than removing the row', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 1, CoinsUnlinked: 0 }] });

    await request(app).delete('/api/denominations/103');
    expect(queryText()).toMatch(/UPDATE\s+Denominations\s+SET\s+IsActive\s*=\s*0/i);
    expect(queryText()).not.toMatch(/DELETE\s+FROM/i);
  });

  it('unlinks the coins BEFORE deactivating the row', async () => {
    // Order matters and it is not arbitrary. FK_Coins_Denomination means no
    // coin can point at a denomination that does not exist, so unlinking
    // first is always safe; deactivating first would leave a window — and,
    // if the second statement failed, a permanent state — in which coins
    // point at a row the API no longer returns.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 1, CoinsUnlinked: 3 }] });

    await request(app).delete('/api/denominations/103');
    const sql = queryText();
    expect(sql.search(/UPDATE\s+Coins/i)).toBeLessThan(sql.search(/UPDATE\s+Denominations/i));
  });

  it('does both in one batch, so a failure cannot leave half of it done', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 1, CoinsUnlinked: 3 }] });

    await request(app).delete('/api/denominations/103');
    expect(mockRequest.query).toHaveBeenCalledTimes(1);
  });

  it('404s when the denomination was not there, having changed nothing', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 0, CoinsUnlinked: 0 }] });

    const res = await request(app).delete('/api/denominations/999');
    expect(res.status).toBe(404);
  });

  it('reports zero unlinked coins without failing', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ Removed: 1, CoinsUnlinked: 0 }] });

    const res = await request(app).delete('/api/denominations/7');
    expect(res.status).toBe(200);
    expect(res.body.coinsUnlinked).toBe(0);
  });
});

describe('GET and POST /api/denominations — the issuer link', () => {
  it('returns the issuer id and name so the screen can group by issuer', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        {
          DenominationId: 103,
          Label: '8 Reales',
          Country: 'MX',
          IssuerId: 7,
          IssuerName: 'Mexico',
          FaceValue: 8,
          SortOrder: 1,
        },
      ],
    });

    const res = await request(app).get('/api/denominations');
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      denominationId: 103,
      label: '8 Reales',
      issuerId: 7,
      issuerName: 'Mexico',
    });
  });

  it('keeps a null issuer null rather than dropping the row', async () => {
    // Denominations.IssuerId is nullable through the migration window. A
    // row with no issuer must still reach the screen — it is the only place
    // it can be given one.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { DenominationId: 5, Label: 'Crown', Country: 'GB', IssuerId: null, IssuerName: null, FaceValue: null, SortOrder: 2 },
      ],
    });

    const res = await request(app).get('/api/denominations');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].issuerId).toBeNull();
  });

  it('stores the issuer a new denomination was added under', async () => {
    // Adding one requires choosing an issuer. Dropping the id here
    // would file every user-added denomination under "No issuer yet", which
    // is the flat list this rebuild exists to end.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ DenominationId: 1200 }],
    });

    const res = await request(app)
      .post('/api/denominations')
      .send({ label: 'Kyat', country: 'MM', issuerId: 62, sortOrder: 10 });

    expect(res.status).toBe(201);
    expect(res.body.issuerId).toBe(62);
    expect(queryText()).toMatch(/IssuerId/);

    // The BOUND PARAMETER, not just the echoed response. Asserting only on
    // the body passes even when the INSERT binds null, because the body is
    // built from the parsed request rather than from what went to SQL —
    // verified by mutation: stubbing the binding to null left this test
    // green until this line existed.
    const bound = Object.fromEntries(capturedInputs.map((input) => [input.name, input.value]));
    expect(bound['issuerId']).toBe(62);
  });

  it('binds a null issuer when none was sent, rather than a zero or a NaN', async () => {
    // The older editor add path sends no issuer, and the column is
    // nullable. Binding Number(undefined) would put NaN into an INT
    // parameter; binding 0 would point at an issuer id that does not exist
    // and fail the foreign key.
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ DenominationId: 1201 }] });

    await request(app).post('/api/denominations').send({ label: 'Crown', country: 'GB' });

    const bound = Object.fromEntries(capturedInputs.map((input) => [input.name, input.value]));
    expect(bound['issuerId']).toBeNull();
  });
});
