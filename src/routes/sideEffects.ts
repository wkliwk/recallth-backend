import { Router, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { SideEffect } from '../models/SideEffect';

const router = Router();

// POST /side-effects — log a new reaction
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);
  const { cabinetItemId, date, symptom, rating, notes } = req.body as {
    cabinetItemId?: string;
    date?: string;
    symptom?: string;
    rating?: unknown;
    notes?: string;
  };

  if (!cabinetItemId || !Types.ObjectId.isValid(cabinetItemId)) {
    res.status(400).json({ success: false, data: null, error: 'cabinetItemId is required and must be valid' });
    return;
  }

  if (!symptom || typeof symptom !== 'string' || symptom.trim() === '') {
    res.status(400).json({ success: false, data: null, error: 'symptom is required' });
    return;
  }

  const ratingNum = Number(rating);
  if (!rating || isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    res.status(400).json({ success: false, data: null, error: 'rating must be a number between 1 and 5' });
    return;
  }

  const entry = await SideEffect.create({
    userId,
    cabinetItemId: new Types.ObjectId(cabinetItemId),
    date: date ? new Date(date) : new Date(),
    symptom: symptom.trim(),
    rating: ratingNum as 1 | 2 | 3 | 4 | 5,
    notes: notes?.trim(),
  });

  res.status(201).json({ success: true, data: entry, error: null });
});

// GET /side-effects — list reactions for the authenticated user
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);
  const { cabinetItemId, limit } = req.query as { cabinetItemId?: string; limit?: string };

  const query: Record<string, unknown> = { userId };

  if (cabinetItemId) {
    if (!Types.ObjectId.isValid(cabinetItemId)) {
      res.status(400).json({ success: false, data: null, error: 'Invalid cabinetItemId' });
      return;
    }
    query.cabinetItemId = new mongoose.Types.ObjectId(cabinetItemId);
  }

  const limitNum = limit ? Math.min(Number(limit), 200) : 50;

  const entries = await SideEffect.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(limitNum)
    .lean();

  res.json({ success: true, data: entries, error: null });
});

// DELETE /side-effects/:id — delete a log entry (owner only)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };

  if (!Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid id' });
    return;
  }

  const entry = await SideEffect.findById(id);
  if (!entry) {
    res.status(404).json({ success: false, data: null, error: 'Entry not found' });
    return;
  }

  if (entry.userId.toString() !== req.userId) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden' });
    return;
  }

  await SideEffect.findByIdAndDelete(id);

  res.json({ success: true, data: { deleted: true, id }, error: null });
});

export default router;
