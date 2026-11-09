/**
 * routes/coins/index.ts — assembles the /api/coins router.
 *
 * Mounted by server.ts as `app.use('/api/coins', coinsRouter)`. This file
 * stitches the pieces together:
 *
 *   reads.ts     GET  /            GET    /:id
 *   writes.ts    POST /            PUT    /:id          DELETE /:id
 *   images.ts    GET  /:id/images  POST   /:id/images   DELETE /:id/images/:imageId
 *   thumbnail.ts GET  /:id/thumbnail
 *   image-source-paths.ts          POST   /image-source-paths
 *
 * The list query that GET / uses lives in list-query.ts (imported by reads.ts)
 * rather than being a router of its own — it is SQL and row assembly, not
 * routing.
 *
 * MOUNT ORDER MATTERS: Express matches routes in registration order. These
 * particular patterns do not overlap (`/:id` is one path segment,
 * `/:id/images` is two), but image-source-paths.ts is mounted FIRST on
 * purpose. It is the only handler whose path is a fixed word in the position
 * where every other handler expects a coin id. `POST /` (create a coin) is an
 * exact-root match and cannot capture `/image-source-paths` today, but
 * "cannot today" is a weaker guarantee than "is matched first", and the
 * failure mode is silent: a 201 Created inserting a junk coin on every batch
 * import.
 */

import { Router } from 'express';
import coinImageSourcePathRoutes from './image-source-paths';
import coinReadRoutes from './reads';
import coinWriteRoutes from './writes';
import coinImageRoutes from './images';
import coinThumbnailRoutes from './thumbnail';

const router = Router();

router.use(coinImageSourcePathRoutes);
router.use(coinReadRoutes);
router.use(coinWriteRoutes);
router.use(coinImageRoutes);
// Last, and position-independent: `/:id/thumbnail` is two segments with a
// literal second one, so no handler above can capture it and it can capture
// none of theirs. It is mounted here rather than folded into images.ts
// because it answers with raw bytes instead of JSON, which is a different
// enough contract to deserve its own file and its own header.
router.use(coinThumbnailRoutes);

export default router;
