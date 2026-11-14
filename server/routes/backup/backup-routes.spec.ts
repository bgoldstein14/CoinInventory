/**
 * routes/backup/backup-routes.spec.ts — the HTTP surface, over real files.
 *
 * The routes themselves are thin, which is the design: nothing in them is
 * load-bearing for safety, because backup/restore.ts validates on its own
 * authority. So what is worth asserting here is exactly the part that
 * ISN'T covered by the modules underneath:
 *
 *   - a refusal is a 400 with a sentence, not a 500 with a stack trace
 *   - an inspection of a bad file is a 200 with a verdict, because the
 *     inspection succeeded and its answer is "no"
 *   - the job endpoints actually track a job from start to finish
 *   - a client that skips the inspect call cannot get past the restore
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { app } from '../../server';
import { resetBackupJobsForTesting } from '../../backup/jobs';
import {
  insertCoins,
  liveCoinCount,
  releaseFileDatabase,
  useFileDatabase,
  type FileDatabase,
} from '../../test-support/real-file-db';

let database: FileDatabase | null = null;

beforeEach(() => {
  resetBackupJobsForTesting();
});

afterEach(async () => {
  resetBackupJobsForTesting();
  if (database) await releaseFileDatabase(database);
  database = null;
});

/** Drives a backup job to a terminal state the way the dialog does. */
async function runBackupJob(directory: string, fileName?: string) {
  const started = await request(app)
    .post('/api/backup/jobs')
    .send(fileName ? { directory, fileName } : { directory });
  expect(started.status).toBe(202);

  const id = started.body.id as string;
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await request(app).get(`/api/backup/jobs/${id}`);
    expect(status.status).toBe(200);
    if (status.body.state !== 'running') return status.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the backup job never finished');
}

describe('GET /api/backup/suggestion', () => {
  it('offers a real folder and a dated .db name', async () => {
    database = await useFileDatabase('suggestion');

    const response = await request(app).get('/api/backup/suggestion');

    expect(response.status).toBe(200);
    expect(response.body.directory).toBeTruthy();
    expect(response.body.fileName).toMatch(/^coin-inventory-backup-\d{4}-\d{2}-\d{2}-\d{4}\.db$/);
    expect(response.body.databasePath).toBe(database.file);
    // So the dialog can warn BEFORE a 600 MB write, not after.
    expect(response.body.databaseSizeBytes).toBeGreaterThan(0);
  });
});

/**
 * The listing endpoint, over HTTP.
 *
 * *** IT READS A DIRECTORY THE CLIENT NAMES. *** The rules themselves are
 * held by backup/list-db-files.spec.ts, where they can be asserted without
 * a web server. What is worth proving HERE is that the HTTP layer does not
 * widen them, and that the three answers a user can get — "here they are",
 * "that folder is empty", "there is no such folder" — arrive as three
 * distinguishable things rather than one.
 *
 * No file database is needed: the route never opens the collection.
 */
describe('GET /api/backup/files', () => {
  let folder = '';

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-route-list-'));
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('returns only the .db files, with a size and a date for each', async () => {
    fs.writeFileSync(path.join(folder, 'coin-inventory-backup-2026-11-14-1432.db'), 'x');
    fs.writeFileSync(path.join(folder, 'app.log'), 'not yours');
    fs.writeFileSync(path.join(folder, '.env'), 'definitely not yours');

    const response = await request(app).get('/api/backup/files').query({ directory: folder });

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].name).toBe('coin-inventory-backup-2026-11-14-1432.db');
    expect(response.body.files[0].sizeBytes).toBe(1);
    expect(typeof response.body.files[0].modifiedAt).toBe('string');
    // The whole point: the client gets a path it can hand straight to the
    // restore without the user retyping it.
    expect(response.body.files[0].path).toBe(
      path.join(path.resolve(folder), 'coin-inventory-backup-2026-11-14-1432.db')
    );
  });

  it('does not escape the folder it was given', async () => {
    // Nothing from a sub-folder, nothing from the parent. Naming a folder
    // reveals that folder's databases and no others.
    const child = path.join(folder, 'inner');
    const grandchild = path.join(child, 'deeper');
    fs.mkdirSync(grandchild, { recursive: true });
    fs.writeFileSync(path.join(folder, 'parent.db'), 'x');
    fs.writeFileSync(path.join(child, 'child.db'), 'x');
    fs.writeFileSync(path.join(grandchild, 'grandchild.db'), 'x');

    const response = await request(app).get('/api/backup/files').query({ directory: child });

    expect(response.status).toBe(200);
    expect(response.body.files.map((file: { name: string }) => file.name)).toEqual(['child.db']);
  });

  it('calls an empty folder empty, with a 200', async () => {
    // A normal outcome, and it must not read as a failure.
    const response = await request(app).get('/api/backup/files').query({ directory: folder });

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
  });

  it('404s a folder that is not there, and names it', async () => {
    const absent = path.join(folder, 'Backpus');

    const response = await request(app).get('/api/backup/files').query({ directory: absent });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/no folder called/i);
  });

  it('404s a path that is a file rather than a folder', async () => {
    // The likeliest mistake once there is a file picker: pasting the
    // backup's own path into the folder box.
    const file = path.join(folder, 'backup.db');
    fs.writeFileSync(file, 'x');

    const response = await request(app).get('/api/backup/files').query({ directory: file });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/is a file, not a folder/i);
  });

  it('400s a blank folder box rather than listing the working directory', async () => {
    // Without the guard an empty box resolves to the server's own cwd,
    // which is both useless and a directory nobody asked about.
    const response = await request(app).get('/api/backup/files').query({ directory: '  ' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Enter the folder/i);
  });

  it('survives a repeated or structured query parameter', async () => {
    // `?directory[0]=x` arrives as an object; `.trim()` on it would throw
    // a TypeError and produce a 500 where a 400 belongs.
    const response = await request(app).get('/api/backup/files?directory[0]=C:%5Ctemp');
    expect(response.status).toBeLessThan(500);
  });
});

describe('POST /api/backup/jobs', () => {
  it('returns 202 and an id immediately, then runs to done', async () => {
    database = await useFileDatabase('job-happy');
    await insertCoins(4);

    const finished = await runBackupJob(database.backupDirectory);

    expect(finished.state).toBe('done');
    expect(finished.percent).toBe(100);
    expect(finished.result.coinCount).toBe(4);
    expect(fs.existsSync(finished.result.path)).toBe(true);
    // The destination is reported back as the REAL path, which may differ
    // from what was asked for if the name had to gain a " (2)".
    expect(finished.destination).toBe(finished.result.path);
  });

  it('answers 400 with a sentence for a folder that does not exist', async () => {
    database = await useFileDatabase('job-bad-folder');

    const response = await request(app)
      .post('/api/backup/jobs')
      .send({ directory: path.join(database.directory, 'nowhere') });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/no folder called/i);
  });

  /* "Only one backup at a time" is asserted in backup/jobs.spec.ts and
   * not here. Over HTTP it is a race: a small test database finishes
   * copying before supertest can send the second request, so the test
   * would pass or fail on how fast the disk was that morning. The rule
   * lives in startBackupJob() and is tested there, synchronously. */

  it('404s for a job id it has never heard of', async () => {
    database = await useFileDatabase('job-unknown');
    const response = await request(app).get('/api/backup/jobs/not-a-real-id');
    expect(response.status).toBe(404);
  });
});

describe('POST /api/backup/jobs/:id/cancel', () => {
  it('accepts the request rather than claiming it has already stopped', async () => {
    database = await useFileDatabase('job-cancel');
    await insertCoins(200);

    const started = await request(app)
      .post('/api/backup/jobs')
      .send({ directory: database.backupDirectory });

    const cancelled = await request(app).post(`/api/backup/jobs/${started.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    // `accepted`, not `cancelled`: the copy notices on its next batch.
    expect(cancelled.body.accepted).toBe(true);

    let finalState = 'running';
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await request(app).get(`/api/backup/jobs/${started.body.id}`);
      finalState = status.body.state;
      if (finalState !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Either outcome is legitimate — a small database can finish before
    // the cancel is seen — but it must be one of them, and a cancelled job
    // must have left nothing behind.
    expect(['cancelled', 'done']).toContain(finalState);
    if (finalState === 'cancelled') {
      expect(fs.readdirSync(database.backupDirectory)).toEqual([]);
    }
  });

  it('404s for an unknown job', async () => {
    database = await useFileDatabase('cancel-unknown');
    const response = await request(app).post('/api/backup/jobs/nope/cancel');
    expect(response.status).toBe(404);
  });
});

describe('POST /api/restore/inspect', () => {
  it('answers 200 with a REFUSAL verdict, not an error status', async () => {
    // The inspection succeeded. Its answer is "no". A 400 here would make
    // "you picked the wrong file" indistinguishable from "the endpoint is
    // broken", and the body is what the dialog needs to explain it.
    database = await useFileDatabase('inspect-refuse');
    const impostor = path.join(database.backupDirectory, 'photo.db');
    fs.writeFileSync(impostor, 'not a database');

    const response = await request(app).post('/api/restore/inspect').send({ path: impostor });

    expect(response.status).toBe(200);
    expect(response.body.decision.verdict).toBe('not-sqlite');
    expect(response.body.decision.acceptable).toBe(false);
    expect(response.body.decision.message).toBeTruthy();
  });

  it('reports the coin count and the date for a good backup', async () => {
    database = await useFileDatabase('inspect-good');
    await insertCoins(6);
    const finished = await runBackupJob(database.backupDirectory);

    const response = await request(app)
      .post('/api/restore/inspect')
      .send({ path: finished.result.path });

    expect(response.status).toBe(200);
    expect(response.body.decision.acceptable).toBe(true);
    expect(response.body.coinCount).toBe(6);
    expect(response.body.provenance.takenAt).toBeTruthy();
  });

  it('400s only for an empty path, which is not a file to have a view on', async () => {
    database = await useFileDatabase('inspect-empty');
    const response = await request(app).post('/api/restore/inspect').send({ path: '   ' });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/restore', () => {
  it('restores, and reports where the old collection went', async () => {
    database = await useFileDatabase('restore-route');
    await insertCoins(3, 'in-backup');
    const finished = await runBackupJob(database.backupDirectory);
    await insertCoins(9, 'added-after');
    expect(await liveCoinCount()).toBe(12);

    const response = await request(app)
      .post('/api/restore')
      .send({ path: finished.result.path });

    expect(response.status).toBe(200);
    expect(response.body.coinCount).toBe(3);
    expect(response.body.serverRestartRequired).toBe(false);

    const aside = response.body.previousCollectionMovedTo as string;
    expect(aside).toBeTruthy();
    expect(fs.existsSync(aside)).toBe(true);

    // And the API is serving the restored collection on the very next
    // request, with no restart.
    const coins = await request(app).get('/api/coins');
    expect(coins.status).toBe(200);
    expect(coins.body).toHaveLength(3);
  });

  it('400s with the refusal sentence for a file from a newer build', async () => {
    database = await useFileDatabase('restore-route-newer');
    await insertCoins(3);
    const finished = await runBackupJob(database.backupDirectory);

    // Byte 60 of a SQLite header is user_version, big-endian.
    const handle = fs.openSync(finished.result.path, 'r+');
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(99, 0);
    fs.writeSync(handle, buffer, 0, 4, 60);
    fs.closeSync(handle);

    const response = await request(app)
      .post('/api/restore')
      .send({ path: finished.result.path });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/newer version of Coin Inventory/i);
    // The dialog gets the inspection too, so it can show the counts next
    // to the refusal rather than an error on its own.
    expect(response.body.inspection.schemaVersion).toBe(99);
    expect(await liveCoinCount()).toBe(3);
  });

  it('cannot be talked past by a client that skips the inspect call', async () => {
    // The route does not get to decide; backup/restore.ts validates again
    // on its own authority. This is that, proved from outside.
    database = await useFileDatabase('restore-route-direct');
    await insertCoins(3);

    const junk = path.join(database.backupDirectory, 'anything.db');
    fs.writeFileSync(junk, 'straight to the restore endpoint');

    const response = await request(app).post('/api/restore').send({ path: junk });

    expect(response.status).toBe(400);
    expect(await liveCoinCount()).toBe(3);
  });
});
