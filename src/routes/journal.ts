import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { DailyLog } from '../models/DailyLog';

const router = Router();

router.use(authenticate);

/**
 * POST /journal
 * Upsert a daily log entry for the authenticated user.
 * Body: { date?, mood, energy, notes? }
 */
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
    return;
  }

  const { mood, energy, notes } = req.body;
  let { date } = req.body;

  // Default to today's date if not provided
  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  }

  // Validate date format YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ success: false, data: null, error: 'date must be in YYYY-MM-DD format' });
    return;
  }

  // Validate mood
  if (mood === undefined || mood === null) {
    res.status(400).json({ success: false, data: null, error: 'mood is required' });
    return;
  }
  const moodNum = Number(mood);
  if (!Number.isInteger(moodNum) || moodNum < 1 || moodNum > 5) {
    res.status(400).json({ success: false, data: null, error: 'mood must be an integer between 1 and 5' });
    return;
  }

  // Validate energy
  if (energy === undefined || energy === null) {
    res.status(400).json({ success: false, data: null, error: 'energy is required' });
    return;
  }
  const energyNum = Number(energy);
  if (!Number.isInteger(energyNum) || energyNum < 1 || energyNum > 5) {
    res.status(400).json({ success: false, data: null, error: 'energy must be an integer between 1 and 5' });
    return;
  }

  // Validate notes length if provided
  if (notes !== undefined && notes !== null && typeof notes === 'string' && notes.length > 500) {
    res.status(400).json({ success: false, data: null, error: 'notes must not exceed 500 characters' });
    return;
  }

  try {
    const updateFields: { mood: number; energy: number; notes?: string } = {
      mood: moodNum,
      energy: energyNum,
    };
    if (notes !== undefined && notes !== null) {
      updateFields.notes = String(notes);
    }

    const entry = await DailyLog.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), date },
      { $set: updateFields },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, data: entry, error: null });
  } catch (err) {
    console.error('[POST /journal] error:', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to save journal entry' });
  }
});

/**
 * GET /journal
 * Return journal entries for the authenticated user over the last N days.
 * Query: ?days=30 (default 30, max 90)
 */
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
    return;
  }

  let days = 30;
  if (req.query.days !== undefined) {
    const parsed = Number(req.query.days);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ success: false, data: null, error: 'days must be a positive integer' });
      return;
    }
    days = Math.min(parsed, 90);
  }

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const entries = await DailyLog.find({
      userId: new Types.ObjectId(userId),
      date: { $gte: cutoffDate },
    }).sort({ date: -1 });

    res.json({ success: true, data: entries, error: null });
  } catch (err) {
    console.error('[GET /journal] error:', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to fetch journal entries' });
  }
});

export default router;
