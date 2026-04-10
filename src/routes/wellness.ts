import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { checkCabinetInteractions } from '../services/interactionChecker';
import { computeWellnessScore } from '../services/wellnessScore';

const router = Router();

/**
 * GET /wellness/score
 * Compute a 0–100 wellness score broken down by:
 *   - profileCompleteness (40 pts, deterministic)
 *   - cabinetQuality (30 pts, deterministic)
 *   - goalAlignment (30 pts, AI via Gemini)
 *
 * Protected: requires valid Bearer JWT (applied at mount point in index.ts).
 */
router.get('/score', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
    return;
  }

  try {
    // Fetch profile and active cabinet items in parallel
    const [profile, activeItems] = await Promise.all([
      HealthProfile.findOne({ userId }),
      CabinetItem.find({ userId, active: true }).sort({ createdAt: -1 }),
    ]);

    // Detect major interactions for penalty calculation
    let hasMajorInteraction = false;
    if (activeItems.length >= 2) {
      const interactions = await checkCabinetInteractions(activeItems);
      hasMajorInteraction = interactions.some((i) => i.severity === 'major');
    }

    const result = await computeWellnessScore(profile, activeItems, hasMajorInteraction);

    res.json({
      success: true,
      data: result,
      error: null,
    });
  } catch (err) {
    console.error('[wellness/score] error:', err);
    res.status(500).json({
      success: false,
      data: null,
      error: 'Failed to compute wellness score',
    });
  }
});

export default router;
