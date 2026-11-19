/**
 * The /api/images router, mounted by server.ts:
 *
 *   file.ts    GET  /api/images/file?path=<absolute path>   open an original
 *   exists.ts  POST /api/images/exists                      which originals still exist
 *
 * SourcePath records where each photo's original file (up to ~46 MB) is on the
 * host. These endpoints deal with files on disk and never touch the database.
 */

import { Router } from 'express';
import imageFileRoutes from './file';
import imageExistsRoutes from './exists';

const router = Router();

// No overlapping paths, so mount order doesn't matter.
router.use(imageFileRoutes);
router.use(imageExistsRoutes);

export default router;
