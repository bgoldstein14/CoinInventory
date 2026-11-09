/**
 * routes/coins/writes.spec.ts — HTTP tests for creating, updating and deleting
 * a coin (routes/coins/writes.ts) plus the transaction unwinding in
 * routes/coins/write-helpers.ts.
 *
 * Three of the tests below are regression guards, not ordinary coverage:
 *
 *   - "sends max-length ... without truncation" — parameter lengths must match
 *     the schema exactly, or the user's data is silently trimmed.
 *   - "updates only the supplied fields ..."    — the partial-update rule.
 *     Writing every column on every save blanks out the user's data.
 *   - "reports the ORIGINAL error even when rollback() itself throws" — a
 *     failing rollback must not hide the error that actually caused the save
 *     to fail.
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
  mockTransaction,
  resetMssqlMock,
} from '../../test-support/mssql-mock';

import { app } from '../../server';

beforeEach(() => {
  resetMssqlMock();
});

describe('PUT /api/coins/:id parameter binding', () => {
  // Was '...Year, Grade, Dealer and CoinSet...'. The coin-level Dealer column
  // was removed, so there is no longer a dealer parameter to check here.
  it('sends max-length Year, Grade and CoinSet values through without truncation', async () => {
    const longYear = 'Y'.repeat(50);
    const longGrade = 'G'.repeat(50);
    const longCoinSet = 'S'.repeat(100);

    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ year: longYear, grade: longGrade, coinSet: longCoinSet });

    expect(res.status).toBe(200);

    const byName = new Map(capturedInputs.map((entry) => [entry.name, entry]));

    expect(byName.get('year')?.value).toBe(longYear);
    expect(byName.get('year')?.type).toMatchObject({ length: 50 });
    expect(byName.get('grade')?.value).toBe(longGrade);
    expect(byName.get('grade')?.type).toMatchObject({ length: 50 });
    expect(byName.get('coinSet')?.value).toBe(longCoinSet);
    expect(byName.get('coinSet')?.type).toMatchObject({ length: 100 });
  });
});

describe('POST /api/coins', () => {
  it('returns 400 when denomination is missing', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ coinType: 'Washington' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('denomination');
  });

  it('creates a coin and returns 201 with id', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'test-id',
        denomination: 'Quarter',
        coinType: 'Washington',
        year: '2024',
        imagePaths: ['data:image/png;base64,img1'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('test-id');
  });

  it('ignores a stray tags key from an out-of-date client', async () => {
    // Tags were removed, table and all. An older client (or a replayed request)
    // could still send the key; it must be silently ignored rather than
    // producing an INSERT against a table that no longer exists.
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-client-id',
        denomination: 'Quarter',
        tags: ['key-date'],
      });

    expect(res.status).toBe(201);
    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('CoinTags');
    }
  });

  it('ignores a stray coin-level dealer key from an out-of-date client', async () => {
    // Coins.Dealer was dropped (migration 006). An older client could still
    // send the key; naming the column in the generated INSERT would make SQL
    // Server reject the whole statement, so it has to be dropped silently.
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-dealer-id',
        denomination: 'Quarter',
        dealer: 'Heritage',
      });

    expect(res.status).toBe(201);
    expect(capturedInputs.some((entry) => entry.name === 'dealer')).toBe(false);
    for (const call of mockRequest.query.mock.calls) {
      // The INSERT targets Coins, so a bare "Dealer" here could only be the
      // dropped coin column. Transactions.Dealer lives in a different route.
      expect(call[0] as string).not.toContain('Dealer');
    }
  });
});

// imagePaths and the SourcePath column
//
// `imagePaths` is polymorphic by design (see the header of writes.ts): each
// element may be the bare base64 string it has always been, or an object
// `{ imageData, sourcePath }`. The mixed-array test below is the one that
// matters — it proves a half-migrated client works, which is the actual state
// of the frontend today.

describe('imagePaths carries sourcePath through POST /api/coins', () => {
  /** The values bound to @sourcePath during the request, in insert order. */
  const boundSourcePaths = (): unknown[] =>
    capturedInputs.filter((entry) => entry.name === 'sourcePath').map((entry) => entry.value);

  it('accepts a mix of bare strings and { imageData, sourcePath } objects', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'mixed-id',
        denomination: 'Dollar',
        imagePaths: [
          // The legacy form: no idea where the original lives -> SQL NULL.
          'data:image/png;base64,legacy',
          // The new form.
          { imageData: 'data:image/png;base64,new', sourcePath: 'C:\\Coin Pictures\\b.jpg' },
        ],
      });

    expect(res.status).toBe(201);
    expect(boundSourcePaths()).toEqual([null, 'C:\\Coin Pictures\\b.jpg']);

    const insertSql = mockRequest.query.mock.calls
      .map((call) => call[0] as string)
      .find((text) => text.includes('INSERT INTO CoinImages'));
    expect(insertSql).toContain('SourcePath');
  });

  it('binds sourcePath as NVARCHAR(400), matching setup-database.sql', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    // A path at exactly the column length must survive untruncated; declaring
    // the parameter shorter than the column would silently trim it.
    const maxLengthPath = 'C:\\' + 'p'.repeat(397);

    await request(app)
      .post('/api/coins')
      .send({
        denomination: 'Dollar',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: maxLengthPath }],
      });

    const input = capturedInputs.find((entry) => entry.name === 'sourcePath');
    expect(input?.value).toBe(maxLengthPath);
    expect(input?.type).toMatchObject({ length: 400 });
  });

  it('keeps SortOrder gap-free when an entry carries no image data', async () => {
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    await request(app)
      .post('/api/coins')
      .send({
        denomination: 'Dollar',
        imagePaths: [
          'data:image/png;base64,a',
          '',                                        // dropped by the normalizer
          { sourcePath: 'C:\\pics\\no-data.jpg' },   // dropped: no imageData
          'data:image/png;base64,b',
        ],
      });

    const sortOrders = capturedInputs
      .filter((entry) => entry.name === 'sortOrder')
      .map((entry) => entry.value);
    expect(sortOrders).toEqual([0, 1]);
  });
});

describe('imagePaths replacement on PUT /api/coins/:id', () => {
  it('still replaces the whole set, now writing SourcePath too', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.png' }],
      });

    expect(res.status).toBe(200);

    const statements = mockRequest.query.mock.calls.map((call) => call[0] as string);
    // Replacement semantics are unchanged: delete-then-insert.
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
    expect(statements.some((s) => s.includes('INSERT INTO CoinImages') && s.includes('SourcePath'))).toBe(true);

    const input = capturedInputs.find((entry) => entry.name === 'sourcePath');
    expect(input?.value).toBe('C:\\pics\\a.png');
  });

  it('does not touch the images when imagePaths is absent from the body', async () => {
    // The partial-update rule, restated for images: a PUT that does not mention
    // imagePaths must leave every photo alone.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    await request(app).put('/api/coins/abc-123').send({ coinType: 'Morgan' });

    const statements = mockRequest.query.mock.calls.map((call) => call[0] as string);
    expect(statements.some((s) => s.includes('CoinImages'))).toBe(false);
  });
});

// SourcePath PRESERVATION across the PUT delete/re-insert
//
// THE BUG THESE TESTS GUARD — read before changing any of them.
//
// PUT /api/coins/:id with an `imagePaths` key deletes every CoinImages row for
// the coin and re-inserts the array it was given. An entry that arrives as a
// bare base64 string carries no source path, so before the fix it came back as
// `SourcePath NULL`. That meant re-ordering one photo, deleting one photo, or
// an ordinary edit that happened to round-trip the array silently erased the
// recorded original-file location of EVERY other photo on the coin — and the
// user then found the "open the original" links had stopped working, with no
// error anywhere to explain it.
//
// The server now reads the existing (ImageData -> SourcePath) pairs inside the
// same transaction, just before the DELETE, and carries a known path forward
// onto any incoming entry that does not supply one of its own.
//
// Every test here drives the mock by STATEMENT TEXT rather than by call order
// (the usual `mockResolvedValueOnce` chain in this file). The preservation read
// adds a query in the middle of the sequence, so an order-indexed chain would
// have to be re-counted every time the handler changes — and a mis-count shows
// up as a confusing wrong-recordset failure rather than a real one.
describe('PUT /api/coins/:id preserves SourcePath across the image replacement', () => {
  /** The values bound to @sourcePath during the request, in insert order. */
  const boundSourcePaths = (): unknown[] =>
    capturedInputs.filter((entry) => entry.name === 'sourcePath').map((entry) => entry.value);

  /** Every statement the handler executed, in order. */
  const statements = (): string[] => mockRequest.query.mock.calls.map((call) => call[0] as string);

  /**
   * Answer each query according to what it asks for, instead of by position.
   * `rows` is what the preservation read (SELECT ImageData, SourcePath ...)
   * should find already in CoinImages for this coin.
   */
  const existingImageRows = (rows: Record<string, unknown>[]): void => {
    mockRequest.query.mockImplementation(async (text: string) => {
      if (text.includes('FROM Coins')) {
        return { recordset: [{ CoinId: 'abc-123' }], rowsAffected: [1] };
      }
      if (text.includes('ImageData, SourcePath FROM CoinImages')) {
        return { recordset: rows, rowsAffected: [rows.length] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
  };

  it('carries a stored SourcePath forward when the entry comes back as a bare string', async () => {
    // The end-to-end repro. The coin has one photo whose original file is
    // recorded. The client re-sends it as a plain base64 string — exactly what
    // a browser session that never opened this coin in the viewer does.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    expect(res.status).toBe(200);
    // Before the fix this was [null] — the path was gone and nothing said so.
    expect(boundSourcePaths()).toEqual(['C:\\Coin Pictures\\alpha.jpg']);
  });

  it('carries it forward when the entry arrives as { imageData, sourcePath: null }', async () => {
    // This is the shape the SHIPPED Angular client actually sends for a photo
    // it has no path for: CoinEditor.withSourcePaths() enriches the whole array
    // as soon as ONE image is known, and ImageSourcePathRegistry.enrich() fills
    // every unknown entry with an explicit `sourcePath: null`.
    //
    // So on this wire an explicit null means "I do not know", NOT "clear it".
    // Reading it as "clear it" would wipe the other seven photos of a coin the
    // moment the user attached an eighth — the exact failure being fixed.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
      { ImageData: 'data:image/png;base64,beta', SourcePath: 'C:\\Coin Pictures\\beta.jpg' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,alpha', sourcePath: null },
          { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\Coin Pictures\\beta.jpg' },
        ],
      });

    expect(res.status).toBe(200);
    expect(boundSourcePaths()).toEqual([
      'C:\\Coin Pictures\\alpha.jpg',
      'C:\\Coin Pictures\\beta.jpg',
    ]);
  });

  it('lets an explicitly supplied path win over the stored one', async () => {
    // Preservation only ever FILLS A GAP. A caller that knows where the file is
    // is the authority — this is how a moved or re-imported photo gets its new
    // location recorded.
    //
    // The SECOND entry is not decoration. The handler skips the preservation
    // read entirely when every entry already supplies a path, so an array of
    // one would never consult the stored values and the test would pass even
    // if the precedence were inverted. The unpathed entry forces the read to
    // happen, which is the only state in which precedence is observable.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\old\\alpha.jpg' },
      { ImageData: 'data:image/png;base64,beta', SourcePath: 'C:\\pics\\beta.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,alpha', sourcePath: 'D:\\new\\alpha.jpg' },
          'data:image/png;base64,beta',
        ],
      });

    expect(boundSourcePaths()).toEqual(['D:\\new\\alpha.jpg', 'C:\\pics\\beta.jpg']);
  });

  it('leaves an image with no stored and no supplied path as NULL', async () => {
    // "Unknown" must stay unknown. Preservation must not invent a path, and in
    // particular must not borrow a different image's path.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: ['data:image/png;base64,alpha', 'data:image/png;base64,brand-new'],
      });

    expect(boundSourcePaths()).toEqual(['C:\\pics\\alpha.jpg', null]);
  });

  it('survives a photo being deleted and the rest re-ordered', async () => {
    // The two operations that provoked the bug in real use. Both send the FULL
    // array, as bare strings, with one entry missing and the order changed.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\pics\\alpha.jpg' },
      { ImageData: 'data:image/png;base64,beta', SourcePath: 'C:\\pics\\beta.jpg' },
      { ImageData: 'data:image/png;base64,gamma', SourcePath: 'C:\\pics\\gamma.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,gamma', 'data:image/png;base64,alpha'] });

    // Matching is by image data, so the surviving two keep THEIR OWN paths in
    // their new positions — a positional scheme would have swapped them.
    expect(boundSourcePaths()).toEqual(['C:\\pics\\gamma.jpg', 'C:\\pics\\alpha.jpg']);
  });

  it('reads the existing paths BEFORE the DELETE, inside the same transaction', async () => {
    // Ordering is the whole fix: once the rows are deleted the paths are gone
    // and there is nothing left to read. Doing the read outside the transaction
    // would also let a concurrent write land between the read and the delete.
    existingImageRows([
      { ImageData: 'data:image/png;base64,alpha', SourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    const text = statements();
    const readIndex = text.findIndex((s) => s.includes('ImageData, SourcePath FROM CoinImages'));
    const deleteIndex = text.findIndex((s) => s.includes('DELETE FROM CoinImages'));

    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeLessThan(deleteIndex);

    // begin() must already have happened, and commit() must come after.
    expect(mockTransaction.begin).toHaveBeenCalled();
    expect(mockTransaction.commit).toHaveBeenCalled();
    expect(mockTransaction.rollback).not.toHaveBeenCalled();
  });

  it('gives every copy of a duplicated image the first stored path', async () => {
    // The same photo can legitimately be attached to a coin twice. ImageData is
    // the only identity an incoming bare string has, so the duplicates are
    // indistinguishable; the documented rule is "lowest SortOrder wins, and
    // every copy gets it". Keeping a real path on both beats nulling both.
    existingImageRows([
      { ImageData: 'data:image/png;base64,dup', SourcePath: 'C:\\pics\\first.jpg' },
      { ImageData: 'data:image/png;base64,dup', SourcePath: 'C:\\pics\\second.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,dup', 'data:image/png;base64,dup'] });

    expect(boundSourcePaths()).toEqual(['C:\\pics\\first.jpg', 'C:\\pics\\first.jpg']);
  });

  it('skips the preservation read when every entry already supplies a path', async () => {
    // ImageData is an NVARCHAR(MAX) blob, so the read is the most expensive
    // thing in this handler. When there is no gap to fill it must not run.
    existingImageRows([]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.jpg' },
          { imageData: 'data:image/png;base64,b', sourcePath: 'C:\\pics\\b.jpg' },
        ],
      });

    expect(statements().some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements().some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
  });

  it('skips the preservation read when imagePaths is empty (clearing all photos)', async () => {
    existingImageRows([]);

    await request(app).put('/api/coins/abc-123').send({ imagePaths: [] });

    expect(statements().some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements().some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
  });

  it('does not run a preservation read on POST /api/coins', async () => {
    // Create has nothing to preserve: the coin's id is brand new, and a request
    // that re-uses an existing id is rejected by the primary key before any
    // image is written. Reading blobs that cannot exist would be pure cost.
    mockRequest.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'fresh-id',
        denomination: 'Dollar',
        imagePaths: ['data:image/png;base64,a'],
      });

    expect(res.status).toBe(201);
    expect(statements().some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements().some((s) => s.includes('DELETE FROM CoinImages'))).toBe(false);
  });
});

describe('PUT /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] });

    const res = await request(app)
      .put('/api/coins/nonexistent')
      .send({ coinType: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates a coin and returns 200', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', denomination: '$1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('abc-123');
  });

  it('updates only the supplied fields so partial edits do not blank unrelated data', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan' });

    const sqlText = mockRequest.query.mock.calls.at(-1)?.[0] as string;
    expect(sqlText).toContain('CoinType = @coinType');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Year = @year');
  });

  it('ignores a stray tags key and still writes the real fields normally', async () => {
    // Removing the tag delete/re-insert from this transaction must not disturb
    // the partial-update behaviour around it. A body carrying BOTH a real field
    // and a leftover `tags` key should update the real field and touch nothing
    // else — in particular, no DELETE against the dropped CoinTags table.
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] })
      .mockResolvedValue({ recordset: [], rowsAffected: [1] });

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', tags: ['key-date'] });

    expect(res.status).toBe(200);

    const sqlText = mockRequest.query.mock.calls.at(-1)?.[0] as string;
    expect(sqlText).toContain('CoinType = @coinType');

    for (const call of mockRequest.query.mock.calls) {
      expect(call[0] as string).not.toContain('CoinTags');
    }
  });
});

describe('DELETE /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [0] });

    const res = await request(app).delete('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a coin and returns 204', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    const res = await request(app).delete('/api/coins/abc-123');
    expect(res.status).toBe(204);
  });
});

// Transaction rollback safety

describe('transaction rollback', () => {
  it('reports the ORIGINAL error even when rollback() itself throws', async () => {
    // Fail the UPDATE...
    const originalError = Object.assign(new Error('Violation of UNIQUE KEY constraint'), { number: 2601 });
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CoinId: 'abc-123' }] }) // existence check
      .mockRejectedValue(originalError);                             // the UPDATE

    // ...and make the rollback fail too, which is exactly what happens when the
    // connection already died. The old code rethrew the rollback error and lost
    // the real cause; we must still classify on the original error (409).
    mockTransaction.rollback.mockRejectedValue(new Error('No transaction is active'));

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ certNumber: '12345' });

    expect(mockTransaction.rollback).toHaveBeenCalled();
    expect(res.status).toBe(409);
  });
});
