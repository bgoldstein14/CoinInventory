/**
 * db/coin-status-columns.spec.ts — CollectionStatus and StorageLocation,
 * written and read back.
 *
 * WHY THESE TWO COLUMNS GET A SPEC OF THEIR OWN
 * db/coin-fields.spec.ts already proves, generically, that every binding's
 * declared length matches the schema. That catches the truncation class of
 * bug and is not repeated here.
 *
 * What it cannot catch is the two things that are specific to these columns:
 *
 *   1. CollectionStatus is NOT NULL. The DEFAULT normalizer used by almost
 *      every other field, normalizeNullable(), turns an empty or absent value
 *      into SQL NULL — which for this column aborts the INSERT. So this field
 *      must carry its own normalizer, and a future "tidy-up" that removes it
 *      would break saving a coin outright.
 *
 *   2. The read side must answer 'owned' for a row whose CollectionStatus is
 *      NULL. Every row in the live SQL Server database is NULL until
 *      migration 010 runs, and a server that returned them as null, '' or
 *      undefined would hand the Angular app a collection it believed the user
 *      did not own.
 *
 * StorageLocation is here as the deliberate contrast: ordinary nullable free
 * text, and it must STAY that way — nothing may normalise, trim or default it.
 *
 * *** WHAT THE MOVE TO SQLITE CHANGED HERE. ***
 *
 *   - The HTTP block at the bottom runs against a real in-memory database
 *     built from db/schema.sql, so it no longer merely watches the bindings
 *     go past: it SELECTs the row back and checks the value landed. That is
 *     the assertion that matches the bug this file exists for — a column the
 *     generated statement never names produces a 200 and a value that has
 *     vanished by the next reload.
 *
 *   - Point 1 above has teeth for the first time. The NOT NULL on
 *     CollectionStatus is now enforced by an engine the tests actually run
 *     against, so "the custom normalizer was deleted" fails as a constraint
 *     violation here rather than only in production.
 *
 *   - *** THE DECLARED LENGTHS BELOW ARE NOW THE ONLY THING ENFORCING A
 *     WIDTH. *** SQLite enforces none. NVARCHAR(20) and NVARCHAR(200) are
 *     applied by db/bind-values.ts out of COIN_FIELDS, so a binding that
 *     drifts from db/schema.sql is not a disagreement the database settles —
 *     it is a hole, and this spec is what stands in it.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  executedSql,
  findQuery,
  insertCoin,
  queryRows,
} from '../test-support/sqlite-test-db';
import { parseTable } from '../test-support/schema-columns';
import { COIN_FIELDS, normalizeCoinValue, rowToCoin } from './index';
import { app } from '../server';

const schemaColumns = parseTable('Coins');

describe('the CollectionStatus binding', () => {
  it('targets the CollectionStatus column at the schema length', () => {
    expect(COIN_FIELDS['collectionStatus'].column).toBe('CollectionStatus');
    expect(COIN_FIELDS['collectionStatus'].maxLength).toBe(20);
    expect(COIN_FIELDS['collectionStatus'].sqlType).toMatchObject({
      storage: 'text',
      maxLength: 20,
      declared: 'NVARCHAR(20)',
    });
    // Read straight out of db/schema.sql, so a widening there that is not
    // mirrored in COIN_FIELDS fails here instead of silently capping saves.
    expect(schemaColumns.get('CollectionStatus')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(20)',
      maxLength: 20,
      notNull: true,
    });
  });

  it("inserts 'owned' when the request body says nothing", () => {
    // Every POST from a client that predates the feature, and every POST the
    // Angular app makes for a coin the user has not touched the status of.
    expect(COIN_FIELDS['collectionStatus'].insertDefault).toBe('owned');
  });

  it('NEVER normalises to null, whatever it is handed', () => {
    // The column is NOT NULL. This is the test that fails if somebody deletes
    // the custom normalizer and lets normalizeNullable() take over — which
    // would turn '' into null and make every such save fail with a constraint
    // violation. The constraint is real in the test database now, so the
    // HTTP test "a blank status still saves" below fails for the same cause.
    for (const input of [undefined, null, '', '   ', 'nonsense', 123]) {
      expect(normalizeCoinValue('collectionStatus', input)).toBe('owned');
    }
  });

  it('keeps a real status', () => {
    expect(normalizeCoinValue('collectionStatus', 'wanted')).toBe('wanted');
    expect(normalizeCoinValue('collectionStatus', 'For Sale')).toBe('for-sale');
  });
});

describe('the StorageLocation binding', () => {
  it('targets the StorageLocation column at the schema length', () => {
    expect(COIN_FIELDS['storageLocation'].column).toBe('StorageLocation');
    expect(COIN_FIELDS['storageLocation'].maxLength).toBe(200);
    expect(COIN_FIELDS['storageLocation'].sqlType).toMatchObject({
      storage: 'text',
      maxLength: 200,
      declared: 'NVARCHAR(200)',
    });
    expect(schemaColumns.get('StorageLocation')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(200)',
      maxLength: 200,
      notNull: false,
    });
  });

  it('is ordinary nullable free text with no normalizer of its own', () => {
    // The point of the field is that every collector organises differently,
    // so nothing may trim it, case it, or map it onto a lookup.
    expect(COIN_FIELDS['storageLocation'].normalize).toBeUndefined();
    expect(normalizeCoinValue('storageLocation', 'Dansco 7070, page 4'))
      .toBe('Dansco 7070, page 4');

    // Untouched means UNTOUCHED, including the surprising cases. The shared
    // normalizeNullable() maps only `undefined` to SQL NULL; an empty string
    // is stored as an empty string and a padded one keeps its padding,
    // exactly as CoinSet and Notes already do. Pinned here so that "tidying
    // up" this field into a trimming normalizer has to argue with a test
    // first -- somebody's shelf really might be called " 2 ".
    expect(normalizeCoinValue('storageLocation', '')).toBe('');
    expect(normalizeCoinValue('storageLocation', '  Box 2  ')).toBe('  Box 2  ');
    expect(normalizeCoinValue('storageLocation', undefined)).toBeNull();
  });
});

describe('reading a coin row back', () => {
  it("reports a NULL CollectionStatus as 'owned'", () => {
    // EVERY row in the live SQL Server database, until migration 010 is run,
    // and every row Stage 2 imports from one that predates it. If this
    // returned null the whole collection would arrive in the app looking
    // un-owned.
    //
    // NOTE: a database built from db/schema.sql cannot itself hold a NULL
    // here — the column is NOT NULL DEFAULT 'owned' and the test database
    // enforces that, as the HTTP block below demonstrates. This mapper rule
    // is about rows arriving from OUTSIDE that schema, which is why it is
    // asserted against rowToCoin() directly and not through a query.
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: null })['collectionStatus'])
      .toBe('owned');
  });

  it("reports a missing CollectionStatus column as 'owned'", () => {
    // A SELECT written before the column existed, or a row from a database
    // the migration has not reached.
    expect(rowToCoin({ CoinId: 'c1' })['collectionStatus']).toBe('owned');
  });

  it('reports a stored status as itself', () => {
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: 'wanted' })['collectionStatus'])
      .toBe('wanted');
  });

  it("falls back to 'owned' for a value the server does not recognise", () => {
    // Hand-edited data, or a row written by a newer build. Taking a coin out
    // of the user's collection over a word is the wrong trade.
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: 'on-loan' })['collectionStatus'])
      .toBe('owned');
  });

  it('reports a NULL StorageLocation as undefined, not as empty text', () => {
    // Matches how every other optional column on this mapper behaves: the key
    // is present but undefined, so JSON.stringify drops it and the client can
    // tell "never recorded" from "recorded as blank".
    expect(rowToCoin({ CoinId: 'c1', StorageLocation: null })['storageLocation'])
      .toBeUndefined();
  });

  it('reports a stored StorageLocation verbatim', () => {
    expect(rowToCoin({ CoinId: 'c1', StorageLocation: 'Safe deposit box 2' })['storageLocation'])
      .toBe('Safe deposit box 2');
  });
});

describe('the columns over HTTP', () => {
  it('POST /api/coins writes both columns', async () => {
    const res = await request(app).post('/api/coins').send({
      id: 'new-1',
      denomination: 'Dollar',
      collectionStatus: 'wanted',
      storageLocation: 'Safe deposit box 2',
    });

    expect(res.status).toBe(201);

    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('collectionStatus')?.value).toBe('wanted');
    expect(byName.get('collectionStatus')?.type).toMatchObject({ maxLength: 20 });
    expect(byName.get('storageLocation')?.value).toBe('Safe deposit box 2');
    expect(byName.get('storageLocation')?.type).toMatchObject({ maxLength: 200 });

    // ...and, which the mock could never show, the values are in the row.
    const [row] = await queryRows(
      "SELECT CollectionStatus, StorageLocation FROM Coins WHERE CoinId = 'new-1'"
    );
    expect(row['CollectionStatus']).toBe('wanted');
    expect(row['StorageLocation']).toBe('Safe deposit box 2');
  });

  it("POST /api/coins writes 'owned' when the body omits the status", async () => {
    const res = await request(app).post('/api/coins').send({ id: 'new-2', denomination: 'Dollar' });

    expect(res.status).toBe(201);
    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('collectionStatus')?.value).toBe('owned');

    const [row] = await queryRows(
      "SELECT CollectionStatus FROM Coins WHERE CoinId = 'new-2'"
    );
    expect(row['CollectionStatus']).toBe('owned');
  });

  it('POST /api/coins still saves when the status box arrives blank', async () => {
    // *** THE NOT NULL CONSTRAINT IS REAL IN THIS DATABASE. *** This is the
    // test that goes red if the custom normalizer is ever replaced by the
    // house normalizeNullable(): '' would become SQL NULL, the INSERT would
    // be refused by the column, and the user would simply be unable to save
    // a coin. It could not be written against the mock, which had no
    // constraints to violate.
    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'new-3', denomination: 'Dollar', collectionStatus: '' });

    expect(res.status).toBe(201);
    const [row] = await queryRows("SELECT CollectionStatus FROM Coins WHERE CoinId = 'new-3'");
    expect(row['CollectionStatus']).toBe('owned');
  });

  it('PUT /api/coins/:id sends a max-length storage location through untruncated', async () => {
    const longLocation = 'L'.repeat(200);

    await insertCoin({ CoinId: 'abc-123', Denomination: 'Dollar' });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ storageLocation: longLocation });

    expect(res.status).toBe(200);

    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('storageLocation')?.value).toBe(longLocation);
    expect(byName.get('storageLocation')?.type).toMatchObject({ maxLength: 200 });

    // Untruncated AT REST, not merely untruncated on the way past. Under
    // SQL Server the column was the backstop; SQLite has none, so the only
    // way to know all 200 characters survived is to read them back.
    const [row] = await queryRows("SELECT StorageLocation FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['StorageLocation']).toBe(longLocation);
  });

  it('PUT /api/coins/:id refuses a storage location past the declared width', async () => {
    // The other half of the same rule, and the half that is now entirely
    // COIN_FIELDS' responsibility: SQL Server raised 8152 on the 201st
    // character, SQLite would store it. db/bind-values.ts raises the
    // equivalent out of the maxLength asserted at the top of this file, and
    // routes/db-error-response.ts turns it into a 400. Refusing is right —
    // the user can retype a refused shelf name, not an invented one.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Dollar', StorageLocation: 'Box 1' });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ storageLocation: 'L'.repeat(201) });

    expect(res.status).toBe(400);
    const [row] = await queryRows("SELECT StorageLocation FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['StorageLocation']).toBe('Box 1');
  });

  it('PUT /api/coins/:id does not touch the status when the body omits it', async () => {
    // The partial-update rule, applied to the new column. A PUT that only
    // changes the notes must not reset a coin to Owned.
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Dollar',
      CollectionStatus: 'wanted',
    });

    const res = await request(app).put('/api/coins/abc-123').send({ notes: 'just a note' });

    expect(res.status).toBe(200);
    expect(capturedInputs().map((entry) => entry.name)).not.toContain('collectionStatus');
    expect(findQuery(/^UPDATE Coins SET/)?.sql).not.toContain('CollectionStatus');

    // And the coin is still wanted, which is the thing the user would have
    // noticed: the old assertion proved only that a parameter was absent.
    const [row] = await queryRows("SELECT CollectionStatus FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['CollectionStatus']).toBe('wanted');

    // Guard against the two assertions above passing because no UPDATE ran
    // at all.
    expect(executedSql().some((sql) => sql.startsWith('UPDATE Coins SET'))).toBe(true);
  });
});
