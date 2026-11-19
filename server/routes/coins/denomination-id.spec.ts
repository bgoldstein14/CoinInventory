/**
 * The denomination link end to end over HTTP. PUT builds its UPDATE from
 * body keys that are in COIN_FIELDS, so a missing binding gave a 200 and
 * saved nothing. Tests check both the generated SQL (names the column) and
 * the stored row (the value landed). Picking a denomination writes both
 * DenominationId and Denomination in one UPDATE.
 *
 * FK_Coins_Denomination is enforced, so ids must be real seeded ones (42 is;
 * the last test checks it).
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  findQuery,
  insertCoin,
  queryRows,
} from '../../test-support/sqlite-test-db';

import { app } from '../../server';

/** A seeded denomination id, so FK_Coins_Denomination is satisfied. */
const SEEDED_DENOMINATION_ID = 42;

/** The coin the PUT tests edit. */
async function coinExists(): Promise<void> {
  await insertCoin({ CoinId: 'abc-123', Denomination: 'Tetradrachm' });
}

/** The UPDATE the PUT handler generates, as text. */
function updateSql(): string {
  return findQuery(/^UPDATE Coins SET/)?.sql ?? '';
}

/** The single row the PUT tests edit, straight out of the table. */
async function storedCoin(): Promise<Record<string, unknown>> {
  const [row] = await queryRows(
    "SELECT Denomination, DenominationId FROM Coins WHERE CoinId = 'abc-123'"
  );
  return row;
}

describe('PUT /api/coins/:id persists DenominationId', () => {
  it('names the column in the generated UPDATE', async () => {
    // Regression guard: without the binding the UPDATE didn't mention DenominationId.
    await coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID });

    expect(res.status).toBe(200);
    expect(updateSql()).toContain('DenominationId = @denominationId');
  });

  it('binds the value as the integer the column expects', async () => {
    await coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID });

    const bound = capturedInputs().find((entry) => entry.name === 'denominationId');
    expect(bound?.value).toBe(SEEDED_DENOMINATION_ID);
  });

  it('actually stores the link, which is what the 200 never proved', async () => {
    // The stored value and its type: a string in an INTEGER column would stop matching joins.
    await coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID });

    const row = await storedCoin();
    expect(row['DenominationId']).toBe(SEEDED_DENOMINATION_ID);

    const [typed] = await queryRows(
      "SELECT typeof(DenominationId) AS StoredType FROM Coins WHERE CoinId = 'abc-123'"
    );
    expect(typed['StoredType']).toBe('integer');
  });

  it('writes BOTH fields when the editor picks a denomination — design §4.1', async () => {
    // Picking a denomination sets the id and the text together (the editor's
    // debounce combines them into one body).
    await coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID, denomination: '8 Reales' });

    expect(res.status).toBe(200);

    const sqlText = updateSql();
    expect(sqlText).toContain('DenominationId = @denominationId');
    expect(sqlText).toContain('Denomination = @denomination');

    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('denominationId')?.value).toBe(SEEDED_DENOMINATION_ID);
    expect(byName.get('denomination')?.value).toBe('8 Reales');

    // One UPDATE, both columns stored.
    expect(await storedCoin()).toEqual({
      Denomination: '8 Reales',
      DenominationId: SEEDED_DENOMINATION_ID,
    });
  });

  it('clears the link when the user picks Other, without touching the text', async () => {
    // "None of these": an explicit null clears the link and keeps the user's text.
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Tetradrachm',
      DenominationId: SEEDED_DENOMINATION_ID,
    });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: null, denomination: 'Trade Dollar' });

    expect(updateSql()).toContain('DenominationId = @denominationId');

    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('denominationId')?.value).toBeNull();
    expect(byName.get('denomination')?.value).toBe('Trade Dollar');

    // The stale id is really gone.
    expect(await storedCoin()).toEqual({
      Denomination: 'Trade Dollar',
      DenominationId: null,
    });
  });

  it('still writes only the fields it was sent', async () => {
    // A body with only the link must not blank the text beside it.
    await coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID });

    const sqlText = updateSql();
    expect(sqlText).toContain('DenominationId = @denominationId');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Country = @country');

    // The recorded text survived.
    const row = await storedCoin();
    expect(row['Denomination']).toBe('Tetradrachm');
    expect(row['DenominationId']).toBe(SEEDED_DENOMINATION_ID);
  });

  it('turns a label sent where an id belongs into NULL rather than failing', async () => {
    // A mis-mapped import value becomes NULL rather than failing the save.
    await coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: '8 Reales' });

    expect(res.status).toBe(200);
    expect(capturedInputs().find((entry) => entry.name === 'denominationId')?.value).toBeNull();
    expect((await storedCoin())['DenominationId']).toBeNull();
  });

  it('refuses an id that links to no denomination — the foreign key is real', async () => {
    // An id that names no row is rejected by the foreign key (547 -> 409).
    await coinExists();

    const res = await request(app).put('/api/coins/abc-123').send({ denominationId: 999999 });

    expect(res.status).toBe(409);
    // Rolled back: the coin is untouched.
    expect(await storedCoin()).toEqual({ Denomination: 'Tetradrachm', DenominationId: null });
  });
});

describe('POST /api/coins carries the link too', () => {
  it('includes DenominationId in the generated INSERT', async () => {
    // The INSERT uses the same COIN_FIELDS map.
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'new-1', denomination: '8 Reales', denominationId: SEEDED_DENOMINATION_ID });

    expect(res.status).toBe(201);

    const insert = findQuery('INSERT INTO Coins');
    expect(insert?.sql).toContain('DenominationId');
    expect(capturedInputs().find((entry) => entry.name === 'denominationId')?.value)
      .toBe(SEEDED_DENOMINATION_ID);

    // ...and the created coin carries it.
    const [row] = await queryRows(
      "SELECT Denomination, DenominationId FROM Coins WHERE CoinId = 'new-1'"
    );
    expect(row).toEqual({ Denomination: '8 Reales', DenominationId: SEEDED_DENOMINATION_ID });
  });
});

describe('GET /api/coins/:id hands the link back', () => {
  it('returns denominationId alongside the recorded text', async () => {
    // It must also come back out, or it empties on reload.
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Pillar Dollar',
      DenominationId: SEEDED_DENOMINATION_ID,
    });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body.denominationId).toBe(SEEDED_DENOMINATION_ID);
    // The text isn't overwritten; both are returned and may disagree.
    expect(res.body.denomination).toBe('Pillar Dollar');
  });

  it('returns null, not a missing key, for a coin that never resolved', async () => {
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: '100 Soles',
      DenominationId: null,
    });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('denominationId');
    expect(res.body.denominationId).toBeNull();
  });

  it('writes the link and reads it back in one go', async () => {
    // The full round trip: written and returned.
    await coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID, denomination: '8 Reales' });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body.denominationId).toBe(SEEDED_DENOMINATION_ID);
    expect(res.body.denomination).toBe('8 Reales');
  });
});

describe('the fixture this file leans on', () => {
  it('has a seeded denomination at the id every test above uses', async () => {
    // Guards the foreign-key assertions from passing vacuously.
    const rows = await queryRows(
      'SELECT DenominationId, Label FROM Denominations WHERE DenominationId = @id',
      { id: SEEDED_DENOMINATION_ID }
    );
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]['Label']).toBe('string');
  });
});
