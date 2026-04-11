import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { BodyStatEntry } from '../models/BodyStatEntry';

const router = Router();

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 90;
const MAX_LIMIT = 365;

// POST /body-stats — log a new body stat entry
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { date, weight, bodyFat, muscleMass, waist, notes } = req.body as {
      date: unknown;
      weight: unknown;
      bodyFat: unknown;
      muscleMass: unknown;
      waist: unknown;
      notes: unknown;
    };

    if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
      res.status(400).json({ success: false, error: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    const hasAtLeastOne =
      typeof weight === 'number' ||
      typeof bodyFat === 'number' ||
      typeof muscleMass === 'number' ||
      typeof waist === 'number';

    if (!hasAtLeastOne) {
      res.status(400).json({
        success: false,
        error: 'At least one of weight, bodyFat, muscleMass, or waist is required',
      });
      return;
    }

    const entry: Record<string, unknown> = {
      userId: req.userId,
      date,
    };
    if (typeof weight === 'number' && Number.isFinite(weight)) entry.weight = weight;
    if (typeof bodyFat === 'number' && Number.isFinite(bodyFat)) entry.bodyFat = bodyFat;
    if (typeof muscleMass === 'number' && Number.isFinite(muscleMass)) entry.muscleMass = muscleMass;
    if (typeof waist === 'number' && Number.isFinite(waist)) entry.waist = waist;
    if (typeof notes === 'string' && notes.trim().length > 0) entry.notes = notes.trim();

    const doc = await BodyStatEntry.create(entry);
    res.status(201).json({ success: true, data: doc });
  } catch (error) {
    console.error('[POST /body-stats]', error);
    res.status(500).json({ success: false, error: 'Failed to save body stat entry' });
  }
});

// GET /body-stats — list entries, sorted by date desc
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, limit: limitParam } = req.query as {
      from?: string;
      to?: string;
      limit?: string;
    };

    const filter: Record<string, unknown> = { userId: req.userId };

    if (from || to) {
      const dateFilter: Record<string, string> = {};
      if (from && DATE_REGEX.test(from)) dateFilter.$gte = from;
      if (to && DATE_REGEX.test(to)) dateFilter.$lte = to;
      if (Object.keys(dateFilter).length > 0) filter.date = dateFilter;
    }

    const parsedLimit = parseInt(limitParam ?? '', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

    const entries = await BodyStatEntry.find(filter)
      .sort({ date: -1 })
      .limit(limit)
      .lean();

    res.json({ success: true, data: entries });
  } catch (error) {
    console.error('[GET /body-stats]', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve body stat entries' });
  }
});

// PUT /body-stats/:id — update an entry
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid entry ID' });
      return;
    }

    const entry = await BodyStatEntry.findOne({ _id: id, userId: req.userId });
    if (!entry) {
      res.status(404).json({ success: false, error: 'Entry not found' });
      return;
    }

    const { date, weight, bodyFat, muscleMass, waist, notes } = req.body as {
      date?: unknown;
      weight?: unknown;
      bodyFat?: unknown;
      muscleMass?: unknown;
      waist?: unknown;
      notes?: unknown;
    };

    if (date !== undefined) {
      if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
        res.status(400).json({ success: false, error: 'date must be a valid YYYY-MM-DD string' });
        return;
      }
      entry.date = date;
    }
    if (typeof weight === 'number' && Number.isFinite(weight)) entry.weight = weight;
    if (typeof bodyFat === 'number' && Number.isFinite(bodyFat)) entry.bodyFat = bodyFat;
    if (typeof muscleMass === 'number' && Number.isFinite(muscleMass)) entry.muscleMass = muscleMass;
    if (typeof waist === 'number' && Number.isFinite(waist)) entry.waist = waist;
    if (typeof notes === 'string') entry.notes = notes.trim() || undefined;

    await entry.save();
    res.json({ success: true, data: entry });
  } catch (error) {
    console.error('[PUT /body-stats/:id]', error);
    res.status(500).json({ success: false, error: 'Failed to update body stat entry' });
  }
});

// DELETE /body-stats/:id — delete an entry
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid entry ID' });
      return;
    }

    const entry = await BodyStatEntry.findOneAndDelete({ _id: id, userId: req.userId });
    if (!entry) {
      res.status(404).json({ success: false, error: 'Entry not found' });
      return;
    }

    res.json({ success: true, data: null });
  } catch (error) {
    console.error('[DELETE /body-stats/:id]', error);
    res.status(500).json({ success: false, error: 'Failed to delete body stat entry' });
  }
});

export default router;
