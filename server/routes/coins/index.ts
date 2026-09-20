/**
 * routes/coins/index.ts — assembles the /api/coins router.
 *
 * server.ts still does `app.use('/api/coins', coinsRouter)`, so from the
 * outside nothing changed: the URLs are exactly what they always were. This
 * file just stitches the three pieces together:
 *
 *   reads.ts   GET  /            GET    /:id
 *   writes.ts  POST /            PUT    /:id          DELETE /:id
 *   images.ts  POST /:id/images  DELETE /:id/images/:imageId
 *
 * The mount ORDER below deliberately matches the order the handlers were
 * declared in when they all lived in one file. Express matches routes in
 * registration order, and although these particular patterns do not overlap
 * (`/:id` is one path segment, `/:id/images` is two), keeping the order
 * identical means this reorganisation cannot possibly change which handler
 * answers a given request.
 */

import { Router } from 'express';
import coinReadRoutes from './reads';
import coinWriteRoutes from './writes';
import coinImageRoutes from './images';

const router = Router();

router.use(coinReadRoutes);
router.use(coinWriteRoutes);
router.use(coinImageRoutes);

export default router;
