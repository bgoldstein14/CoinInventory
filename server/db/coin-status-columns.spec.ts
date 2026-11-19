/**
 * CollectionStatus and StorageLocation, written and read back.
 *
 * CollectionStatus is NOT NULL, so it needs its own normalizer (the default
 * turns empty into NULL and would fail the INSERT), and rows without a value
 * must read back as 'owned'. StorageLocation is the contrast: plain nullable
 * free text that must not be normalized.
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
    // Read from db/schema.sql, so a widening not mirrored in COIN_FIELDS fails here.
    expect(schemaColumns.get('CollectionStatus')).toMatchObject({
      storage: 'TEXT',
      declared: 'NVARCHAR(20)',
      maxLength: 20,
      notNull: true,
    });
  });

  it("inserts 'owned' when the request body says nothing", () => {
    // POSTs from older clients, or where the user never touched the status.
    expect(COIN_FIELDS['collectionStatus'].insertDefault).toBe('owned');
  });

  it('NEVER normalises to null, whatever it is handed', () => {
    // Fails if the custom normalizer is replaced by normalizeNullable(),
    // which would turn '' into NULL and fail the NOT NULL column.
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
    // Collectors organise differently, so nothing may trim, case or map it.
    expect(COIN_FIELDS['storageLocation'].normalize).toBeUndefined();
    expect(normalizeCoinValue('storageLocation', 'Dansco 7070, page 4'))
      .toBe('Dansco 7070, page 4');

    // normalizeNullable() maps only undefined to NULL; '' and padding are kept.
    expect(normalizeCoinValue('storageLocation', '')).toBe('');
    expect(normalizeCoinValue('storageLocation', '  Box 2  ')).toBe('  Box 2  ');
    expect(normalizeCoinValue('storageLocation', undefined)).toBeNull();
  });
});

describe('reading a coin row back', () => {
  it("reports a NULL CollectionStatus as 'owned'", () => {
    // Rows from outside this schema (e.g. imported from a pre-010 SQL Server
    // database) can be NULL and must not arrive looking un-owned.
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: null })['collectionStatus'])
      .toBe('owned');
  });

  it("reports a missing CollectionStatus column as 'owned'", () => {
    // A row from a database without the column.
    expect(rowToCoin({ CoinId: 'c1' })['collectionStatus']).toBe('owned');
  });

  it('reports a stored status as itself', () => {
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: 'wanted' })['collectionStatus'])
      .toBe('wanted');
  });

  it("falls back to 'owned' for a value the server does not recognise", () => {
    // Hand-edited data or a newer build's token.
    expect(rowToCoin({ CoinId: 'c1', CollectionStatus: 'on-loan' })['collectionStatus'])
      .toBe('owned');
  });

  it('reports a NULL StorageLocation as undefined, not as empty text', () => {
    // Key present but undefined, so JSON.stringify drops it.
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

    // ...and the values are in the row.
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
    // Fails if the custom normalizer is replaced: '' would become NULL and
    // the NOT NULL column would reject the INSERT.
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

    // Read back to confirm all 200 characters were stored.
    const [row] = await queryRows("SELECT StorageLocation FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['StorageLocation']).toBe(longLocation);
  });

  it('PUT /api/coins/:id refuses a storage location past the declared width', async () => {
    // The 201st character is refused by db/bind-values.ts (HTTP 400), not stored.
    await insertCoin({ CoinId: 'abc-123', Denomination: 'Dollar', StorageLocation: 'Box 1' });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ storageLocation: 'L'.repeat(201) });

    expect(res.status).toBe(400);
    const [row] = await queryRows("SELECT StorageLocation FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['StorageLocation']).toBe('Box 1');
  });

  it('PUT /api/coins/:id does not touch the status when the body omits it', async () => {
    // A PUT that only changes the notes must not reset the status to owned.
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: 'Dollar',
      CollectionStatus: 'wanted',
    });

    const res = await request(app).put('/api/coins/abc-123').send({ notes: 'just a note' });

    expect(res.status).toBe(200);
    expect(capturedInputs().map((entry) => entry.name)).not.toContain('collectionStatus');
    expect(findQuery(/^UPDATE Coins SET/)?.sql).not.toContain('CollectionStatus');

    const [row] = await queryRows("SELECT CollectionStatus FROM Coins WHERE CoinId = 'abc-123'");
    expect(row['CollectionStatus']).toBe('wanted');

    // Guard against passing because no UPDATE ran at all.
    expect(executedSql().some((sql) => sql.startsWith('UPDATE Coins SET'))).toBe(true);
  });
});
