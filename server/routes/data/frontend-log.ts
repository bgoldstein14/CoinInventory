/**
 * POST /api/log: lets the Angular app write to the server's log, so frontend
 * and backend messages share one timeline. Always 204; a logging endpoint
 * must never fail the caller.
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
