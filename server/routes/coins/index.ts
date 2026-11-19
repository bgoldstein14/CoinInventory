/**
 * The /api/coins router, mounted by server.ts:
 *
 *   reads.ts              GET  /            GET    /:id
 *   writes.ts             POST /            PUT    /:id          DELETE /:id
 *   images.ts             GET  /:id/images  POST   /:id/images   DELETE /:id/images/:imageId
 *   thumbnail.ts          GET  /:id/thumbnail
 *   image-source-paths.ts POST /image-source-paths
 *
 * image-source-paths is mounted first because its fixed path sits where other
 * handlers expect a coin id; matching it first guarantees `POST /` can never
 * capture it and create a junk coin.
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
// Can't collide with the routes above. Separate file because it returns raw bytes, not JSON.
router.use(coinThumbnailRoutes);

export default router;
