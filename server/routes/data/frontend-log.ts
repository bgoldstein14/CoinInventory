/**
 * routes/data/frontend-log.ts — POST /api/log
 *
 * The one endpoint here does not touch the database at all: it lets the
 * Angular app in the browser write into the same server/logs/app.log file the
 * backend uses. When the user reports "it broke", having the frontend's own
 * messages interleaved with the server's in one timeline is what makes the
 * problem findable.
 *
 * Because it is a pure logging sink it always answers 204 No Content and never
 * fails the caller — a logging endpoint that can error would be worse than no
 * logging endpoint at all.
 *
 * Mounted (via routes/data/index.ts) at /api, so the path is /api/log.
 */

import { Router, Request, Response } from 'express';
import { log } from '../../logger';

const router = Router();

router.post('/log', (req: Request, res: Response) => {
  const { level, message, details, source } = req.body ?? {};
  log(level ?? 'INFO', `[${source ?? 'frontend'}] ${message}`, details);
  res.status(204).send();
});

export default router;
