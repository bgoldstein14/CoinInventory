/**
 * db/coin-status-columns.spec.ts — CollectionStatus and StorageLocation,
 * written and read back.
 *
 * WHY THESE TWO COLUMNS GET A SPEC OF THEIR OWN
 * db/coin-fields.spec.ts already proves, generically, that every binding's
 * declared length matches setup-database.sql. That catches the truncation
 * class of bug and is not repeated here.
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
 *      NULL. Every row in the live database is NULL until migration 010 runs,
 *      and a server that returned them as null, '' or undefined would hand
 *      the Angular app a collection it believed the user did not own.
 *
 * StorageLocation is here as the deliberate contrast: ordinary nullable free
 * text, and it must STAY that way — nothing may normalise, trim or default it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('mssql', async () => {
  const { createMssqlMock } = await import('../test-support/mssql-mock');
  return createMssqlMock();
});

import { capturedInputs, mockRequest, resetMssqlMock } from '../test-support/mssql-mock';
import { COIN_FIELDS, normalizeCoinValue, rowToCoin } from './index';
import { app } from '../server';

beforeEach(() => {
  resetMssqlMock();
});

describe('the CollectionStatus binding', () => {
  it('targets the CollectionStatus column at the schema length', () => {
    expect(COIN_FIELDS['collectionStatus'].column).toBe('CollectionStatus');
    expect(COIN_FIELDS['collectionStatus'].maxLength).toBe(20);
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
    // violation.
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
    // EVERY row in the live database, until migration 010 is run. If this
    // returned null the whole collection would arrive in the app looking
    // un-owned.
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
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app).post('/api/coins').send({
      id: 'new-1',
      denomination: 'Dollar',
      collectionStatus: 'wanted',
      storageLocation: 'Safe deposit box 2',
    });

    expect(res.status).toBe(201);

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));
    expect(byName.get('collectionStatus')?.value).toBe('wanted');
    expect(byName.get('collectionStatus')?.type).toMatchObject({ length: 20 });
    expect(byName.get('storageLocation')?.value).toBe('Safe deposit box 2');
    expect(byName.get('storageLocation')?.type).toMatchObject({ length: 200 });
  });

  it("POST /api/coins writes 'owned' when the body omits the status", async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app).post('/api/coins').send({ id: 'new-2', denomination: 'Dollar' });

    expect(res.status).toBe(201);
    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));
    expect(byName.get('collectionStatus')?.value).toBe('owned');
  });

  it('PUT /api/coins/:id sends a max-length storage location through untruncated', async () => {
    const longLocation = 'L'.repeat(200);

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ storageLocation: longLocation });

    expect(res.status).toBe(200);

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));
    expect(byName.get('storageLocation')?.value).toBe(longLocation);
    expect(byName.get('storageLocation')?.type).toMatchObject({ length: 200 });
  });

  it('PUT /api/coins/:id does not touch the status when the body omits it', async () => {
    // The partial-update rule, applied to the new column. A PUT that only
    // changes the notes must not reset a coin to Owned.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app).put('/api/coins/abc-123').send({ notes: 'just a note' });

    expect(res.status).toBe(200);
    expect(capturedInputs.map((entry) => entry.name)).not.toContain('collectionStatus');
  });
});
