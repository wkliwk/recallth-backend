import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'recallth-api',
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
});

export default router;
