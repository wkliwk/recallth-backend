import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { CabinetItem } from '../models/CabinetItem';
import { checkCabinetInteractions } from '../services/interactionChecker';

const router = Router();

/**
 * GET /cabinet/interactions
 * Check all active cabinet items for pairwise interactions.
 * Protected: requires valid Bearer JWT (applied at mount point in index.ts).
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
    return;
  }

  const items = await CabinetItem.find({ userId, active: true }).sort({ createdAt: -1 });

  if (items.length < 2) {
    res.json({ success: true, data: { interactions: [] }, error: null });
    return;
  }

  const interactions = await checkCabinetInteractions(items);

  res.json({
    success: true,
    data: { interactions },
    error: null,
  });
});

export default router;
