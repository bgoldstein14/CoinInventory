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
 *
 * *** WHAT CHANGED WHEN THE SUITE MOVED ONTO A REAL DATABASE. ***
 *
 * Every assertion that used to read "the handler bound @sourcePath to X" can
 * now read "the row in CoinImages has SourcePath X", and most of them do. The
 * difference is not stylistic: the old form proved the route asked for the
 * right thing, and the new form proves the right thing happened. Under the
 * mock a handler could bind a perfect set of parameters into a statement with
 * a typo'd column name and every test here would still pass.
 *
 * Statement-text assertions survive in exactly two places, and both are
 * things a row cannot show:
 *
 *   - "updates only the supplied fields" — a column MISSING from a generated
 *     UPDATE produces a 200, no error, and a value that is gone on the next
 *     reload. The absence is the bug, and an absence leaves no row to read.
 *   - "skips the preservation read" — the point is that an expensive query
 *     did NOT run. A query that does not run changes nothing to look at.
 *
 * The rollback tests are the other place real behaviour had to be arranged
 * rather than asserted on a spy: `mockTransaction.rollback` proved only that a
 * function was called. See the last describe.
 */

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

import {
  capturedInputs,
  executedSql,
  executedQueries,
  insertCoin,
  queryRows,
  withTestDb,
} from '../../test-support/sqlite-test-db';
import { DbTransaction } from '../../db';
import { app } from '../../server';

/** A coin for the UPDATE paths to act on. */
async function existingCoin(id = 'abc-123'): Promise<string> {
  return insertCoin({ CoinId: id, Denomination: '$1', CoinType: 'Morgan', Year: '1921' });
}

/** The CoinImages rows of one coin, in display order. */
function imagesOf(coinId = 'abc-123'): Promise<Record<string, unknown>[]> {
  return queryRows(
    'SELECT ImageData, SortOrder, SourcePath FROM CoinImages WHERE CoinId = @coinId ORDER BY SortOrder',
    { coinId }
  );
}

/** The SourcePath of each of a coin's images, in display order. */
async function storedSourcePaths(coinId = 'abc-123'): Promise<unknown[]> {
  return (await imagesOf(coinId)).map((row) => row['SourcePath']);
}

/** Give a coin some photographs, with or without recorded originals. */
async function giveImages(
  coinId: string,
  images: Array<{ imageData: string; sourcePath: string | null }>
): Promise<void> {
  await withTestDb((database) => {
    const insert = database.prepare(
      'INSERT INTO CoinImages (CoinId, ImageData, SortOrder, SourcePath) ' +
        'VALUES (@coinId, @imageData, @sortOrder, @sourcePath)'
    );
    images.forEach((image, index) => {
      insert.run({
        coinId,
        imageData: image.imageData,
        sortOrder: index,
        sourcePath: image.sourcePath,
      });
    });
  });
}

describe('PUT /api/coins/:id parameter binding', () => {
  // Was '...Year, Grade, Dealer and CoinSet...'. The coin-level Dealer column
  // was removed, so there is no longer a dealer parameter to check here.
  it('sends max-length Year, Grade and CoinSet values through without truncation', async () => {
    const longYear = 'Y'.repeat(50);
    const longGrade = 'G'.repeat(50);
    const longCoinSet = 'S'.repeat(100);

    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ year: longYear, grade: longGrade, coinSet: longCoinSet });

    expect(res.status).toBe(200);

    // THE REAL ASSERTION, which the mock could not make: the characters are
    // in the table. Under `mssql` an under-declared parameter trimmed the
    // value before it ever left the process; under SQLite an over-declared
    // one lets too much through. Only the stored row settles it.
    const [stored] = await queryRows('SELECT Year, Grade, CoinSet FROM Coins WHERE CoinId = @id', {
      id: 'abc-123',
    });
    expect(stored['Year']).toBe(longYear);
    expect(stored['Grade']).toBe(longGrade);
    expect(stored['CoinSet']).toBe(longCoinSet);

    // The declared widths are what db/bind-values.ts enforces, so they are
    // still worth pinning: they are now the only thing that refuses a 51st
    // character rather than storing it.
    const byName = new Map(capturedInputs().map((entry) => [entry.name, entry]));
    expect(byName.get('year')?.type).toMatchObject({ declared: 'NVARCHAR(50)' });
    expect(byName.get('grade')?.type).toMatchObject({ declared: 'NVARCHAR(50)' });
    expect(byName.get('coinSet')?.type).toMatchObject({ declared: 'NVARCHAR(100)' });
  });

  it('refuses a value one character past the declared width, rather than trimming it', async () => {
    // The other half of the test above, and a NEW behaviour worth pinning.
    // `mssql` silently cut the 51st character off and reported success, so a
    // grade the user typed came back shorter with nothing to explain it.
    // SQLite enforces nothing at all, so db/bind-values.ts refuses the value
    // and routes/db-error-response.ts answers 400. The stored row must be
    // untouched: a rejected edit must not be a partial edit.
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ grade: 'G'.repeat(51) });

    expect(res.status).toBe(400);
    const [stored] = await queryRows('SELECT Grade FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(stored['Grade']).toBeNull();
  });
});

describe('POST /api/coins', () => {
  it('returns 400 when denomination is missing', async () => {
    const res = await request(app)
      .post('/api/coins')
      .send({ coinType: 'Washington' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('denomination');
    // Nothing reached the database: the guard runs before the transaction.
    expect(executedSql()).toEqual([]);
  });

  it('creates a coin and returns 201 with id', async () => {
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

    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'test-id' });
    expect(coin['Denomination']).toBe('Quarter');
    expect(coin['CoinType']).toBe('Washington');
    expect(coin['Year']).toBe('2024');
    // The documented INSERT defaults, which the mock never applied.
    expect(coin['Source']).toBe('manual');
    expect(coin['HasCacSticker']).toBe(0);
    expect(coin['CollectionStatus']).toBe('owned');

    expect(await imagesOf('test-id')).toEqual([
      { ImageData: 'data:image/png;base64,img1', SortOrder: 0, SourcePath: null },
    ]);
  });

  it('ignores a stray tags key from an out-of-date client', async () => {
    // Tags were removed, table and all. An older client (or a replayed request)
    // could still send the key; it must be silently ignored rather than
    // producing an INSERT against a table that no longer exists.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-client-id',
        denomination: 'Quarter',
        tags: ['key-date'],
      });

    expect(res.status).toBe(201);
    for (const statement of executedSql()) {
      expect(statement).not.toContain('CoinTags');
    }
  });

  it('ignores a stray coin-level dealer key from an out-of-date client', async () => {
    // Coins.Dealer was dropped (migration 006). An older client could still
    // send the key; naming the column in the generated INSERT would make the
    // statement fail outright, so it has to be dropped silently.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'stale-dealer-id',
        denomination: 'Quarter',
        dealer: 'Heritage',
      });

    expect(res.status).toBe(201);
    expect(capturedInputs().some((entry) => entry.name === 'dealer')).toBe(false);
    for (const statement of executedSql()) {
      // The INSERT targets Coins, so a bare "Dealer" here could only be the
      // dropped coin column. Transactions.Dealer lives in a different route.
      expect(statement).not.toContain('Dealer');
    }
  });

  it('refuses a second coin with the same id, and leaves the first one alone', async () => {
    // Could not be tested at all against the mock, which had no primary key.
    // It matters because POST accepts a client-supplied id: a replayed import
    // must not overwrite a coin the user has since edited.
    await insertCoin({ CoinId: 'dup-id', Denomination: '$1', CoinType: 'Morgan' });

    const res = await request(app)
      .post('/api/coins')
      .send({ id: 'dup-id', denomination: 'Quarter', coinType: 'Washington' });

    // 2627 (duplicate key) -> 409 Conflict. See routes/db-error-response.ts.
    expect(res.status).toBe(409);

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'dup-id' });
    expect(coin['CoinType']).toBe('Morgan');
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
  it('accepts a mix of bare strings and { imageData, sourcePath } objects', async () => {
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
    expect(await imagesOf('mixed-id')).toEqual([
      { ImageData: 'data:image/png;base64,legacy', SortOrder: 0, SourcePath: null },
      {
        ImageData: 'data:image/png;base64,new',
        SortOrder: 1,
        SourcePath: 'C:\\Coin Pictures\\b.jpg',
      },
    ]);
  });

  it('binds sourcePath as NVARCHAR(400), matching db/schema.sql', async () => {
    // A path at exactly the column length must survive untruncated; declaring
    // the parameter shorter than the column would make db/bind-values.ts
    // refuse a path the schema allows.
    const maxLengthPath = 'C:\\' + 'p'.repeat(397);

    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'maxpath-id',
        denomination: 'Dollar',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: maxLengthPath }],
      });

    expect(res.status).toBe(201);
    expect(await storedSourcePaths('maxpath-id')).toEqual([maxLengthPath]);

    const input = capturedInputs().find((entry) => entry.name === 'sourcePath');
    expect(input?.type).toMatchObject({ declared: 'NVARCHAR(400)', maxLength: 400 });
  });

  it('refuses a path past 400 characters rather than cutting it in half', async () => {
    // db/bindings.ts says this surfaces as an HTTP 400 "rather than being
    // quietly cut in half". Against the mock that claim was untestable, and
    // against SQLite alone it would be false — nothing but the binding layer
    // enforces it.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'longpath-id',
        denomination: 'Dollar',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\' + 'p'.repeat(500) }],
      });

    expect(res.status).toBe(400);
    // The whole save is a transaction, so the coin is not left behind either.
    expect(await queryRows('SELECT CoinId FROM Coins WHERE CoinId = @id', { id: 'longpath-id' })).toEqual([]);
  });

  it('keeps SortOrder gap-free when an entry carries no image data', async () => {
    await request(app)
      .post('/api/coins')
      .send({
        id: 'gaps-id',
        denomination: 'Dollar',
        imagePaths: [
          'data:image/png;base64,a',
          '',                                        // dropped by the normalizer
          { sourcePath: 'C:\\pics\\no-data.jpg' },   // dropped: no imageData
          'data:image/png;base64,b',
        ],
      });

    const rows = await imagesOf('gaps-id');
    expect(rows.map((row) => row['SortOrder'])).toEqual([0, 1]);
    expect(rows.map((row) => row['ImageData'])).toEqual([
      'data:image/png;base64,a',
      'data:image/png;base64,b',
    ]);
  });
});

describe('imagePaths replacement on PUT /api/coins/:id', () => {
  it('still replaces the whole set, now writing SourcePath too', async () => {
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,old', sourcePath: 'C:\\pics\\old.png' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.png' }],
      });

    expect(res.status).toBe(200);
    // Replacement semantics, proved by the contents rather than by the verbs:
    // the old row is gone and only the new one is there.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,a', SortOrder: 0, SourcePath: 'C:\\pics\\a.png' },
    ]);
  });

  it('does not touch the images when imagePaths is absent from the body', async () => {
    // The partial-update rule, restated for images: a PUT that does not mention
    // imagePaths must leave every photo alone.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,keep', sourcePath: 'C:\\pics\\keep.png' },
    ]);

    await request(app).put('/api/coins/abc-123').send({ coinType: 'Morgan' });

    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,keep', SortOrder: 0, SourcePath: 'C:\\pics\\keep.png' },
    ]);
    expect(executedSql().some((statement) => statement.includes('CoinImages'))).toBe(false);
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
// *** THESE ARE NOW END-TO-END TESTS. *** The previous version arranged the
// "existing" rows by teaching a mock to answer one particular SELECT with one
// particular recordset, which meant the test and the handler had to agree on
// the text of that query. The rows below are really in CoinImages, the DELETE
// really deletes them, and the assertion reads what really survived — so the
// test now fails if the preservation read's WHERE clause is wrong, which the
// mock version could not detect.
describe('PUT /api/coins/:id preserves SourcePath across the image replacement', () => {
  it('carries a stored SourcePath forward when the entry comes back as a bare string', async () => {
    // The end-to-end repro. The coin has one photo whose original file is
    // recorded. The client re-sends it as a plain base64 string — exactly what
    // a browser session that never opened this coin in the viewer does.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    expect(res.status).toBe(200);
    // Before the fix this was [null] — the path was gone and nothing said so.
    expect(await storedSourcePaths()).toEqual(['C:\\Coin Pictures\\alpha.jpg']);
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
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\Coin Pictures\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\Coin Pictures\\beta.jpg' },
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
    expect(await storedSourcePaths()).toEqual([
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
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\old\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\pics\\beta.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,alpha', sourcePath: 'D:\\new\\alpha.jpg' },
          'data:image/png;base64,beta',
        ],
      });

    expect(await storedSourcePaths()).toEqual(['D:\\new\\alpha.jpg', 'C:\\pics\\beta.jpg']);
  });

  it('leaves an image with no stored and no supplied path as NULL', async () => {
    // "Unknown" must stay unknown. Preservation must not invent a path, and in
    // particular must not borrow a different image's path.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: ['data:image/png;base64,alpha', 'data:image/png;base64,brand-new'],
      });

    expect(await storedSourcePaths()).toEqual(['C:\\pics\\alpha.jpg', null]);
  });

  it('survives a photo being deleted and the rest re-ordered', async () => {
    // The two operations that provoked the bug in real use. Both send the FULL
    // array, as bare strings, with one entry missing and the order changed.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
      { imageData: 'data:image/png;base64,beta', sourcePath: 'C:\\pics\\beta.jpg' },
      { imageData: 'data:image/png;base64,gamma', sourcePath: 'C:\\pics\\gamma.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,gamma', 'data:image/png;base64,alpha'] });

    // Matching is by image data, so the surviving two keep THEIR OWN paths in
    // their new positions — a positional scheme would have swapped them.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,gamma', SortOrder: 0, SourcePath: 'C:\\pics\\gamma.jpg' },
      { ImageData: 'data:image/png;base64,alpha', SortOrder: 1, SourcePath: 'C:\\pics\\alpha.jpg' },
    ]);
    // Beta really is gone, which is the half of "replacement" the old
    // bound-parameter assertion never looked at.
    expect((await imagesOf()).length).toBe(2);
  });

  it('reads the existing paths BEFORE the DELETE, inside the same transaction', async () => {
    // Ordering is the whole fix: once the rows are deleted the paths are gone
    // and there is nothing left to read. Doing the read outside the transaction
    // would also let a concurrent write land between the read and the delete.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,alpha'] });

    const readIndex = executedQueries.findIndex((event) =>
      event.sql.includes('ImageData, SourcePath FROM CoinImages')
    );
    const deleteIndex = executedQueries.findIndex((event) =>
      event.sql.includes('DELETE FROM CoinImages')
    );

    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeLessThan(deleteIndex);

    // *** AND BOTH ARE INSIDE THE TRANSACTION. *** The old version asserted
    // that `begin()` and `commit()` had been called on a mock, which proves a
    // function ran, not that these two statements were enclosed by it.
    // `inTransaction` is recorded per statement, so it says the thing the
    // comment above claims. The existence check, by design, is outside.
    expect(executedQueries[readIndex].inTransaction).toBe(true);
    expect(executedQueries[deleteIndex].inTransaction).toBe(true);
    expect(executedQueries[0].sql).toContain('SELECT CoinId FROM Coins');
    expect(executedQueries[0].inTransaction).toBe(false);

    // Committed, not rolled back: the row survives the request.
    expect(await storedSourcePaths()).toEqual(['C:\\pics\\alpha.jpg']);
  });

  it('gives every copy of a duplicated image the first stored path', async () => {
    // The same photo can legitimately be attached to a coin twice. ImageData is
    // the only identity an incoming bare string has, so the duplicates are
    // indistinguishable; the documented rule is "lowest SortOrder wins, and
    // every copy gets it". Keeping a real path on both beats nulling both.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,dup', sourcePath: 'C:\\pics\\first.jpg' },
      { imageData: 'data:image/png;base64,dup', sourcePath: 'C:\\pics\\second.jpg' },
    ]);

    await request(app)
      .put('/api/coins/abc-123')
      .send({ imagePaths: ['data:image/png;base64,dup', 'data:image/png;base64,dup'] });

    expect(await storedSourcePaths()).toEqual(['C:\\pics\\first.jpg', 'C:\\pics\\first.jpg']);
  });

  it('skips the preservation read when every entry already supplies a path', async () => {
    // ImageData is an unbounded text blob, so the read is the most expensive
    // thing in this handler. When there is no gap to fill it must not run.
    // A query that does not run leaves no row to inspect, so this stays a
    // statement-text assertion.
    await existingCoin();

    await request(app)
      .put('/api/coins/abc-123')
      .send({
        imagePaths: [
          { imageData: 'data:image/png;base64,a', sourcePath: 'C:\\pics\\a.jpg' },
          { imageData: 'data:image/png;base64,b', sourcePath: 'C:\\pics\\b.jpg' },
        ],
      });

    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
  });

  it('skips the preservation read when imagePaths is empty (clearing all photos)', async () => {
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,alpha', sourcePath: 'C:\\pics\\alpha.jpg' },
    ]);

    await request(app).put('/api/coins/abc-123').send({ imagePaths: [] });

    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(true);
    // An empty array really does mean "delete them all".
    expect(await imagesOf()).toEqual([]);
  });

  it('does not run a preservation read on POST /api/coins', async () => {
    // Create has nothing to preserve: the coin's id is brand new, and a request
    // that re-uses an existing id is rejected by the primary key before any
    // image is written. Reading blobs that cannot exist would be pure cost.
    const res = await request(app)
      .post('/api/coins')
      .send({
        id: 'fresh-id',
        denomination: 'Dollar',
        imagePaths: ['data:image/png;base64,a'],
      });

    expect(res.status).toBe(201);
    const statements = executedSql();
    expect(statements.some((s) => s.includes('ImageData, SourcePath FROM CoinImages'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM CoinImages'))).toBe(false);
  });
});

describe('PUT /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    const res = await request(app)
      .put('/api/coins/nonexistent')
      .send({ coinType: 'Updated' });
    expect(res.status).toBe(404);
  });

  it('updates a coin and returns 200', async () => {
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', denomination: '$1' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('abc-123');

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Updated Morgan');
  });

  it('updates only the supplied fields so partial edits do not blank unrelated data', async () => {
    await insertCoin({
      CoinId: 'abc-123',
      Denomination: '$1',
      CoinType: 'Morgan',
      Year: '1921',
      Notes: 'Nice toning',
    });

    await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan' });

    // A column MISSING from the generated statement is the bug, and an
    // absence leaves nothing to read — so the statement text is still the
    // right thing to assert here.
    const sqlText = executedSql().at(-1) as string;
    expect(sqlText).toContain('CoinType = @coinType');
    expect(sqlText).not.toContain('Denomination = @denomination');
    expect(sqlText).not.toContain('Year = @year');

    // And the consequence, which the mock could not show: everything else
    // really is still there.
    const [coin] = await queryRows('SELECT * FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Updated Morgan');
    expect(coin['Denomination']).toBe('$1');
    expect(coin['Year']).toBe('1921');
    expect(coin['Notes']).toBe('Nice toning');
  });

  it('ignores a stray tags key and still writes the real fields normally', async () => {
    // Removing the tag delete/re-insert from this transaction must not disturb
    // the partial-update behaviour around it. A body carrying BOTH a real field
    // and a leftover `tags` key should update the real field and touch nothing
    // else — in particular, no DELETE against the dropped CoinTags table.
    await existingCoin();

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({ coinType: 'Updated Morgan', tags: ['key-date'] });

    expect(res.status).toBe(200);

    const sqlText = executedSql().at(-1) as string;
    expect(sqlText).toContain('CoinType = @coinType');

    for (const statement of executedSql()) {
      expect(statement).not.toContain('CoinTags');
    }
  });
});

describe('DELETE /api/coins/:id', () => {
  it('returns 404 for non-existent coin', async () => {
    const res = await request(app).delete('/api/coins/nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a coin and returns 204', async () => {
    await existingCoin();

    const res = await request(app).delete('/api/coins/abc-123');
    expect(res.status).toBe(204);
    expect(await queryRows('SELECT CoinId FROM Coins WHERE CoinId = @id', { id: 'abc-123' })).toEqual([]);
  });

  it('takes the coin\'s photographs and transactions with it', async () => {
    // routes/coins/writes.ts says "images cascade" and never deletes them
    // itself. Against the mock that was an unverified claim about a database
    // nobody had; ON DELETE CASCADE is now declared in db/schema.sql and
    // foreign keys are genuinely enforced, so it can be proved.
    await existingCoin();
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,a', sourcePath: null },
    ]);
    await withTestDb((database) => {
      database
        .prepare(
          'INSERT INTO Transactions (TransactionId, CoinId, TransactionType, TransactionDate, Amount) ' +
            "VALUES ('t1', 'abc-123', 'purchase', '2024-01-01', 10)"
        )
        .run();
    });

    expect(await request(app).delete('/api/coins/abc-123')).toMatchObject({ status: 204 });

    expect(await imagesOf()).toEqual([]);
    expect(await queryRows('SELECT TransactionId FROM Transactions')).toEqual([]);
  });
});

// Transaction rollback safety

describe('transaction rollback', () => {
  it('rolls the whole save back when one statement in it fails', async () => {
    // The guarantee the previous version of this file could only take on
    // trust. The UPDATE succeeds and the image replacement then fails on an
    // over-long SourcePath; the coin's type must NOT be left changed.
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1', CoinType: 'Morgan' });
    await giveImages('abc-123', [
      { imageData: 'data:image/png;base64,keep', sourcePath: 'C:\\pics\\keep.png' },
    ]);

    const res = await request(app)
      .put('/api/coins/abc-123')
      .send({
        coinType: 'Changed',
        imagePaths: [{ imageData: 'data:image/png;base64,a', sourcePath: 'C:\\' + 'p'.repeat(500) }],
      });

    expect(res.status).toBe(400);

    const [coin] = await queryRows('SELECT CoinType FROM Coins WHERE CoinId = @id', { id: 'abc-123' });
    expect(coin['CoinType']).toBe('Morgan');
    // The DELETE that had already run inside the transaction is undone too.
    expect(await imagesOf()).toEqual([
      { ImageData: 'data:image/png;base64,keep', SortOrder: 0, SourcePath: 'C:\\pics\\keep.png' },
    ]);
  });

  it('reports the ORIGINAL error even when rollback() itself throws', async () => {
    // safeRollback() in write-helpers.ts exists because `rollback()` throws
    // surprisingly often — if the connection already died, or if the engine
    // already aborted the transaction itself. The old code rethrew the
    // rollback error and lost the real cause, in exactly the cases where the
    // real cause matters most.
    //
    // The previous version arranged this by telling `mockTransaction.rollback`
    // to reject, which proved only that a spy had been called. Here the
    // transaction is REAL: the stub rolls back properly first — so the lock is
    // released and the data is genuinely unwound — and then rolls back a
    // second time, which is what actually produces "No transaction is active."
    // in production.
    await insertCoin({ CoinId: 'abc-123', Denomination: '$1', CoinType: 'Morgan' });

    const realRollback = DbTransaction.prototype.rollback;
    const spy = vi
      .spyOn(DbTransaction.prototype, 'rollback')
      .mockImplementation(async function (this: DbTransaction) {
        await realRollback.call(this);
        // The transaction is finished now, so this throws for real.
        await realRollback.call(this);
      });

    try {
      // A foreign key that does not resolve: FK_Coins_Catalog has no cascade
      // and no SET NULL, so this is a genuine 547 from the engine.
      const res = await request(app)
        .put('/api/coins/abc-123')
        .send({ catalogId: 999999 });

      expect(spy).toHaveBeenCalled();
      // 547 -> 409. If the rollback's own error had replaced it, this would
      // be a 500.
      expect(res.status).toBe(409);
    } finally {
      spy.mockRestore();
    }

    // The failed save left nothing behind, and the connection is usable: the
    // next request works, which it would not if the lock had leaked.
    const [coin] = await queryRows('SELECT CatalogId, CoinType FROM Coins WHERE CoinId = @id', {
      id: 'abc-123',
    });
    expect(coin['CatalogId']).toBeNull();
    expect(coin['CoinType']).toBe('Morgan');
  });
});
