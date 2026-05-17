import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { DoseEffect } from '../models/DoseEffect';

const router = Router();

interface SupplementEffectAgg {
  name: string;
  avgEnergy: number | null;
  avgFocus: number | null;
  avgSleep: number | null;
  avgMood: number | null;
  count: number;
}

// GET /effects?days=30
// Returns per-supplement average effect ratings for the authenticated user over the given time window.
// Only includes supplements with count >= 3.
router.get('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.userId);

    const rawDays = Number(req.query.days ?? 30);
    const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, 90);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const pipeline = [
      {
        $match: {
          userId,
          ratedAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$supplementName',
          count: { $sum: 1 },
          // Average only non-null values via $avg (MongoDB ignores nulls/missing fields automatically)
          avgEnergy: { $avg: '$energy' },
          avgFocus: { $avg: '$focus' },
          avgSleep: { $avg: '$sleep' },
          avgMood: { $avg: '$mood' },
        },
      },
      {
        $match: { count: { $gte: 3 } },
      },
      {
        $sort: { count: -1 as const },
      },
    ];

    const raw = await DoseEffect.aggregate<{
      _id: string;
      count: number;
      avgEnergy: number | null;
      avgFocus: number | null;
      avgSleep: number | null;
      avgMood: number | null;
    }>(pipeline);

    const roundOrNull = (v: number | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      return Math.round(v * 10) / 10;
    };

    const supplements: SupplementEffectAgg[] = raw.map((doc) => ({
      name: doc._id,
      avgEnergy: roundOrNull(doc.avgEnergy),
      avgFocus: roundOrNull(doc.avgFocus),
      avgSleep: roundOrNull(doc.avgSleep),
      avgMood: roundOrNull(doc.avgMood),
      count: doc.count,
    }));

    res.json({ success: true, data: { supplements }, error: null });
  } catch (error) {
    console.error('Effects GET error:', error);
    res.status(500).json({ success: false, data: null, error: 'Failed to retrieve effect ratings' });
  }
});

export { router as effectsRouter };
