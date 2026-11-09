/**
 * routes/coins/denomination-id.spec.ts — the denomination link, end to end
 * over HTTP.
 *
 * WHY A ROUTE-LEVEL TEST AND NOT JUST THE BINDING TEST
 * db/denomination-column.spec.ts proves COIN_FIELDS has an entry and that the
 * entry normalises correctly. That is necessary and it is not sufficient: the
 * failure this feature actually had was that `PUT /api/coins/:id` generates
 * its UPDATE from the keys PRESENT IN THE REQUEST BODY intersected with
 * COIN_FIELDS, so a missing binding produced a 200 response, no SQL naming
 * the column, and a picker that looked like it worked and saved nothing.
 *
 * Only a test that drives the real express app and then reads the generated
 * SQL and the bound parameters can see that. These tests do exactly that.
 *
 * They also pin the two halves of the WRITE RULE: picking a
 * denomination writes BOTH fields, and they must both arrive in one UPDATE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../../test-support/mssql-mock');
  return createMssqlMock();
});

import {
  capturedInputs,
  mockRequest,
  resetMssqlMock,
} from '../../test-support/mssql-mock';

import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

/** The coin exists; every later query succeeds. The shape writes.spec.ts uses. */
function coinExists(): void {
  mockRequest.query
    .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
    .mockResolvedValue({ recordset: [], rowsAffected: [1] });
}

/** The UPDATE is the last statement the PUT handler runs. */
function lastSql(): string {
  return mockRequest.query.mock.calls.at(-1)?.[0] as string;
}

describe('PUT /api/coins/:id persists DenominationId', () => {
  it('names the column in the generated UPDATE', async () => {
    // THE REGRESSION GUARD. Before the binding existed this body produced an
    // UPDATE that did not mention DenominationId at all, and a 200.
    coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: 42 });

    expect(res.status).toBe(200);
    expect(lastSql()).toContain('DenominationId = @denominationId');
  });

  it('binds the value as the integer the column expects', async () => {
    coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: 42 });

    const bound = capturedInputs.find((entry) => entry.name === 'denominationId');
    expect(bound?.value).toBe(42);
  });

  it('writes BOTH fields when the editor picks a denomination — design §4.1', async () => {
    // The write rule: picking a denomination sets the id AND the text to that
    // denomination's label, so the two agree from then on. The editor sends
    // them as separate single-field edits; the debounce coalesces them into
    // one body, and this is that body.
    coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: 42, denomination: '8 Reales' });

    expect(res.status).toBe(200);

    const sqlText = lastSql();
    expect(sqlText).toContain('DenominationId = @denominationId');
    expect(sqlText).toContain('Denomination = @denomination');

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));
    expect(byName.get('denominationId')?.value).toBe(42);
    expect(byName.get('denomination')?.value).toBe('8 Reales');
  });

  it('clears the link when the user picks Other, without touching the text', async () => {
    // The custom box: "none of these" means the link goes and the
    // user's own wording stays. An explicit null must reach the column —
    // `undefined` would be dropped from the JSON body and the stale id would
    // survive, which is the quiet half of the original bug.
    coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: null, denomination: 'Trade Dollar' });

    expect(lastSql()).toContain('DenominationId = @denominationId');

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));
    expect(byName.get('denominationId')?.value).toBeNull();
    expect(byName.get('denomination')?.value).toBe('Trade Dollar');
  });

  it('still writes only the fields it was sent', async () => {
    // The partial-update rule a previous refactor broke. A body carrying only
    // the link must not blank the text beside it — the text is the ONLY
    // record of what the source said and nothing in this app may rewrite it.
    coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: 42 });

    const sqlText = lastSql();
    expect(sqlText).toContain('DenominationId = @denominationId');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Country = @country');
  });

  it('turns a label sent where an id belongs into NULL rather than failing', async () => {
    // An import mapping gone wrong. NULL is recoverable in one click; an
    // 8114 at save time aborts the transaction and loses the coin.
    coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: '8 Reales' });

    expect(res.status).toBe(200);
    expect(capturedInputs.find((entry) => entry.name === 'denominationId')?.value).toBeNull();
  });
});

describe('POST /api/coins carries the link too', () => {
  it('includes DenominationId in the generated INSERT', async () => {
    // The INSERT is generated from the same COIN_FIELDS map, so one binding
    // covers both paths. Asserted rather than assumed, because "it is the
    // same map" is exactly the kind of reasoning that stops being true.
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({ denomination: '8 Reales', denominationId: 42 });

    expect(res.status).toBe(201);

    const insert = mockRequest.query.mock.calls
      .map((call) => call[0] as string)
      .find((text) => text.includes('INSERT INTO Coins'));

    expect(insert).toContain('DenominationId');
    expect(capturedInputs.find((entry) => entry.name === 'denominationId')?.value).toBe(42);
  });
});

describe('GET /api/coins/:id hands the link back', () => {
  it('returns denominationId alongside the recorded text', async () => {
    // A field the API accepts but does not return empties itself on the next
    // reload, and the user never sees why.
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        CoinId: 'abc-123',
        Denomination: 'Pillar Dollar',
        DenominationId: 42,
      }],
    }).mockResolvedValue({ recordset: [] });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body.denominationId).toBe(42);
    // The text is NOT overwritten by the resolution. Both are returned and
    // they are allowed to disagree — that is the point of keeping both.
    expect(res.body.denomination).toBe('Pillar Dollar');
  });

  it('returns null, not a missing key, for a coin that never resolved', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{
        CoinId: 'abc-123',
        Denomination: '100 Soles',
        DenominationId: null,
      }],
    }).mockResolvedValue({ recordset: [] });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('denominationId');
    expect(res.body.denominationId).toBeNull();
  });
});
