/**
 * routes/images/index.ts — assembles the /api/images router.
 *
 * server.ts does `app.use('/api/images', imagesRouter)`, so:
 *
 *   file.ts    GET  /file    -> GET  /api/images/file?path=<absolute path>
 *   exists.ts  POST /exists  -> POST /api/images/exists
 *
 * ------------------------------------------------------------------
 * What this router is for, in one paragraph
 * ------------------------------------------------------------------
 * CoinImages.ImageData holds a downscaled base64 copy of each photo — small
 * enough to ship to the browser and display. CoinImages.SourcePath records
 * where the ORIGINAL file (up to ~46 MB) sits on the machine hosting the app.
 * This router is the pair of endpoints the UI needs to make that path useful:
 * one to OPEN the original, and one to ask whether it is still there so a dead
 * link can be greyed out instead of failing when clicked.
 *
 * These two endpoints deliberately live OUTSIDE /api/coins. They are about
 * files on disk, not about coins — neither of them touches the database or the
 * connection pool at all, which is unusual enough in this backend to be worth
 * pointing out. `withDb()` and `sendDbError()` make no appearance here.
 *
 * Both files carry long headers of their own; the two things most worth knowing
 * before editing either:
 *
 *   - file.ts explains why the backend must serve the file at all (browsers
 *     refuse to navigate from an http page to a file:// URL) and documents the
 *     "read any image on the host" security tradeoff this route accepts.
 *   - exists.ts explains why the existence check is a single batched POST
 *     rather than one request per image.
 */

import { Router } from 'express';
import imageFileRoutes from './file';
import imageExistsRoutes from './exists';

const router = Router();

// Paths do not overlap (`GET /file` vs `POST /exists`), so mount order is not
// significant here — it just matches the reading order of the header above.
router.use(imageFileRoutes);
router.use(imageExistsRoutes);

export default router;
