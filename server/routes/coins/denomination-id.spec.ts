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
 *
 * *** WHAT THE MOVE TO SQLITE CHANGED HERE, AND WHY IT MATTERS MOST IN THIS
 * FILE OF ALL OF THEM. ***
 *
 * The bug above has a second, stronger witness now. Reading the generated SQL
 * proves the statement NAMES the column; reading the ROW BACK proves the
 * value LANDED — and "the value is gone on the next reload" is literally what
 * the user experienced. Every test below that writes something now ends by
 * SELECTing it out of a real in-memory database built from db/schema.sql.
 * The SQL-text assertions are kept beside them, because they fail more
 * legibly when a binding is removed and because a statement can name a column
 * and still be the wrong statement.
 *
 * Two further things the mssql mock could not represent, and this file now
 * relies on:
 *
 *   - FK_Coins_Denomination IS ENFORCED. PRAGMA foreign_keys is on for every
 *     connection, so the ids used here have to be ids the seed really
 *     created. Id 42 is a seeded denomination; the last test pins that so the
 *     others cannot pass vacuously.
 *   - The coin has to EXIST before it can be PUT to. The mock faked that with
 *     a queued recordset whose position in the call order had to be kept in
 *     step by hand; `insertCoin()` puts a row in the table instead.
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

/** The coin the PUT tests edit. Replaces the mock's queued "it exists" row. */
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
    // THE REGRESSION GUARD. Before the binding existed this body produced an
    // UPDATE that did not mention DenominationId at all, and a 200.
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
    // *** THE TEST THIS FILE WAS ALWAYS TRYING TO BE. *** "200, and the value
    // is gone on the next reload" is the bug; a SELECT is the only assertion
    // that is false when it happens. SQLite is dynamically typed, so the
    // stored TYPE is checked too: a string that slipped past the normalizer
    // would sit in an INTEGER column as text and stop matching any join.
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
    // The write rule: picking a denomination sets the id AND the text to that
    // denomination's label, so the two agree from then on. The editor sends
    // them as separate single-field edits; the debounce coalesces them into
    // one body, and this is that body.
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

    // One UPDATE, both columns, both values at rest.
    expect(await storedCoin()).toEqual({
      Denomination: '8 Reales',
      DenominationId: SEEDED_DENOMINATION_ID,
    });
  });

  it('clears the link when the user picks Other, without touching the text', async () => {
    // The custom box: "none of these" means the link goes and the
    // user's own wording stays. An explicit null must reach the column —
    // `undefined` would be dropped from the JSON body and the stale id would
    // survive, which is the quiet half of the original bug.
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

    // The stale id is really gone, not merely absent from a parameter list.
    expect(await storedCoin()).toEqual({
      Denomination: 'Trade Dollar',
      DenominationId: null,
    });
  });

  it('still writes only the fields it was sent', async () => {
    // The partial-update rule a previous refactor broke. A body carrying only
    // the link must not blank the text beside it — the text is the ONLY
    // record of what the source said and nothing in this app may rewrite it.
    await coinExists();

    await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: SEEDED_DENOMINATION_ID });

    const sqlText = updateSql();
    expect(sqlText).toContain('DenominationId = @denominationId');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Country = @country');

    // And the recorded text survived the save, which is the consequence the
    // SQL assertions above are a proxy for.
    const row = await storedCoin();
    expect(row['Denomination']).toBe('Tetradrachm');
    expect(row['DenominationId']).toBe(SEEDED_DENOMINATION_ID);
  });

  it('turns a label sent where an id belongs into NULL rather than failing', async () => {
    // An import mapping gone wrong. NULL is recoverable in one click; an
    // 8114 at save time aborts the transaction and loses the coin.
    await coinExists();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ denominationId: '8 Reales' });

    expect(res.status).toBe(200);
    expect(capturedInputs().find((entry) => entry.name === 'denominationId')?.value).toBeNull();
    expect((await storedCoin())['DenominationId']).toBeNull();
  });

  it('refuses an id that links to no denomination — the foreign key is real', async () => {
    // NEW, AND ONLY POSSIBLE NOW. FK_Coins_Denomination is declared in
    // db/schema.sql and PRAGMA foreign_keys is on, so a number that passes
    // the normalizer but names no row is rejected by the database (547 ->
    // HTTP 409) instead of creating a link that resolves to nothing. The
    // mssql mock had no constraints and reported success for this.
    await coinExists();

    const res = await request(app).put('/api/coins/abc-123').send({ denominationId: 999999 });

    expect(res.status).toBe(409);
    // The transaction rolled back, so the coin is untouched.
    expect(await storedCoin()).toEqual({ Denomination: 'Tetradrachm', DenominationId: null });
  });
});

describe('POST /api/coins carries the link too', () => {
  it('includes DenominationId in the generated INSERT', async () => {
    // The INSERT is generated from the same COIN_FIELDS map, so one binding
    // covers both paths. Asserted rather than assumed, because "it is the
    // same map" is exactly the kind of reasoning that stops being true.
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'new-1', denomination: '8 Reales', denominationId: SEEDED_DENOMINATION_ID });

    expect(res.status).toBe(201);

    const insert = findQuery('INSERT INTO Coins');
    expect(insert?.sql).toContain('DenominationId');
    expect(capturedInputs().find((entry) => entry.name === 'denominationId')?.value)
      .toBe(SEEDED_DENOMINATION_ID);

    // ...and the created coin really carries it.
    const [row] = await queryRows(
      "SELECT Denomination, DenominationId FROM Coins WHERE CoinId = 'new-1'"
    );
    expect(row).toEqual({ Denomination: '8 Reales', DenominationId: SEEDED_DENOMINATION_ID });
  });
});

describe('GET /api/coins/:id hands the link back', () => {
  it('returns denominationId alongside the recorded text', async () => {
    // A field the API accepts but does not return empties itself on the next
    // reload, and the user never sees why.
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Pillar Dollar',
      DenominationId: SEEDED_DENOMINATION_ID,
    });

    const res = await request(app).get('/api/coins/abc-123');

    expect(res.status).toBe(200);
    expect(res.body.denominationId).toBe(SEEDED_DENOMINATION_ID);
    // The text is NOT overwritten by the resolution. Both are returned and
    // they are allowed to disagree — that is the point of keeping both.
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
    // The whole round trip in one test, because the two halves above were
    // each half of the original bug: accepted but never written, or written
    // but never returned. Either one reads to the user as "the picker does
    // not save".
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
    // Without this, every foreign-key-satisfying assertion in the file could
    // be passing because the constraint found nothing to check.
    const rows = await queryRows(
      'SELECT DenominationId, Label FROM Denominations WHERE DenominationId = @id',
      { id: SEEDED_DENOMINATION_ID }
    );
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]['Label']).toBe('string');
  });
});
