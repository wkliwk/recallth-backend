import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { BloodworkEntry } from '../models/BloodworkEntry';

const router = Router();

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// POST /bloodwork — create a new bloodwork entry
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { date, marker, value, unit } = req.body as {
      date: unknown;
      marker: unknown;
      value: unknown;
      unit: unknown;
    };

    if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
      res.status(400).json({ error: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    if (typeof marker !== 'string' || marker.trim().length === 0) {
      res.status(400).json({ error: 'marker must be a non-empty string' });
      return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      res.status(400).json({ error: 'value must be a number' });
      return;
    }

    if (typeof unit !== 'string' || unit.trim().length === 0) {
      res.status(400).json({ error: 'unit must be a non-empty string' });
      return;
    }

    const entry = await BloodworkEntry.create({
      userId: req.userId,
      date,
      marker: marker.trim(),
      value,
      unit: unit.trim(),
    });

    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    console.error('Bloodwork POST error:', error);
    res.status(500).json({ error: 'Failed to save bloodwork entry' });
  }
});

// GET /bloodwork — list all entries for the user, optionally filtered by marker
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const filter: { userId: string | undefined; marker?: string } = { userId: req.userId };

    if (typeof req.query.marker === 'string' && req.query.marker.length > 0) {
      filter.marker = req.query.marker;
    }

    const entries = await BloodworkEntry.find(filter).sort({ date: 1 });

    res.json({ success: true, data: entries });
  } catch (error) {
    console.error('Bloodwork GET error:', error);
    res.status(500).json({ error: 'Failed to retrieve bloodwork entries' });
  }
});

export { router as bloodworkRouter };
