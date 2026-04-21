import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { ExerciseSession } from '../models/ExerciseSession';

const router = Router();

// ─── GET /exercise — list user's sessions, newest first ──────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { limit: limitStr, offset: offsetStr } = req.query as {
      limit?: string;
      offset?: string;
    };

    const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(offsetStr ?? '0', 10) || 0, 0);

    const sessions = await ExerciseSession.find({ userId })
      .sort({ date: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean();

    res.json({ success: true, data: sessions });
  } catch (err) {
    console.error('[GET /exercise]', err);
    res.status(500).json({ success: false, message: 'Failed to get exercise sessions' });
  }
});

// ─── POST /exercise — create session ─────────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const {
      activityType,
      activityLabel,
      date,
      durationMinutes,
      intensity,
      distanceKm,
      exercises,
      notes,
    } = req.body as {
      activityType?: unknown;
      activityLabel?: unknown;
      date?: unknown;
      durationMinutes?: unknown;
      intensity?: unknown;
      distanceKm?: unknown;
      exercises?: unknown;
      notes?: unknown;
    };

    // Required field validation
    if (typeof activityType !== 'string' || activityType.trim().length === 0) {
      res.status(400).json({ success: false, message: 'activityType is required' });
      return;
    }

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ success: false, message: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    if (typeof durationMinutes !== 'number' || durationMinutes <= 0) {
      res.status(400).json({ success: false, message: 'durationMinutes must be a positive number' });
      return;
    }

    const validIntensities = ['easy', 'moderate', 'hard'] as const;
    if (typeof intensity !== 'string' || !validIntensities.includes(intensity as typeof validIntensities[number])) {
      res.status(400).json({
        success: false,
        message: `intensity must be one of: ${validIntensities.join(', ')}`,
      });
      return;
    }

    const sessionData: Record<string, unknown> = {
      userId,
      activityType: activityType.trim(),
      date,
      durationMinutes,
      intensity,
    };

    if (typeof activityLabel === 'string' && activityLabel.trim().length > 0) {
      sessionData.activityLabel = activityLabel.trim();
    }
    if (typeof distanceKm === 'number') {
      sessionData.distanceKm = distanceKm;
    }
    if (Array.isArray(exercises)) {
      sessionData.exercises = exercises;
    }
    if (typeof notes === 'string' && notes.trim().length > 0) {
      sessionData.notes = notes.trim();
    }

    const session = await ExerciseSession.create(sessionData);
    res.status(201).json({ success: true, data: session });
  } catch (err) {
    console.error('[POST /exercise]', err);
    res.status(500).json({ success: false, message: 'Failed to create exercise session' });
  }
});

// ─── GET /exercise/:id — get single session ───────────────────────────────

router.get('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: 'Invalid session id' });
      return;
    }

    const session = await ExerciseSession.findById(id).lean();

    if (!session) {
      res.status(404).json({ success: false, message: 'Exercise session not found' });
      return;
    }

    if (session.userId.toString() !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    res.json({ success: true, data: session });
  } catch (err) {
    console.error('[GET /exercise/:id]', err);
    res.status(500).json({ success: false, message: 'Failed to get exercise session' });
  }
});

// ─── PATCH /exercise/:id — partial update ─────────────────────────────────

router.patch('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: 'Invalid session id' });
      return;
    }

    const session = await ExerciseSession.findById(id);

    if (!session) {
      res.status(404).json({ success: false, message: 'Exercise session not found' });
      return;
    }

    if (session.userId.toString() !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    const {
      activityType,
      activityLabel,
      date,
      durationMinutes,
      intensity,
      distanceKm,
      exercises,
      notes,
    } = req.body as {
      activityType?: unknown;
      activityLabel?: unknown;
      date?: unknown;
      durationMinutes?: unknown;
      intensity?: unknown;
      distanceKm?: unknown;
      exercises?: unknown;
      notes?: unknown;
    };

    const updates: Record<string, unknown> = {};

    if (typeof activityType === 'string' && activityType.trim().length > 0) {
      updates.activityType = activityType.trim();
    }
    if (typeof activityLabel === 'string') {
      updates.activityLabel = activityLabel.trim();
    }
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      updates.date = date;
    }
    if (typeof durationMinutes === 'number' && durationMinutes > 0) {
      updates.durationMinutes = durationMinutes;
    }

    const validIntensities = ['easy', 'moderate', 'hard'] as const;
    if (typeof intensity === 'string' && validIntensities.includes(intensity as typeof validIntensities[number])) {
      updates.intensity = intensity;
    }
    if (typeof distanceKm === 'number') {
      updates.distanceKm = distanceKm;
    }
    if (Array.isArray(exercises)) {
      updates.exercises = exercises;
    }
    if (typeof notes === 'string') {
      updates.notes = notes.trim();
    }

    const updated = await ExerciseSession.findByIdAndUpdate(id, { $set: updates }, { new: true });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[PATCH /exercise/:id]', err);
    res.status(500).json({ success: false, message: 'Failed to update exercise session' });
  }
});

// ─── DELETE /exercise/:id — delete session ────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: 'Invalid session id' });
      return;
    }

    const session = await ExerciseSession.findById(id);

    if (!session) {
      res.status(404).json({ success: false, message: 'Exercise session not found' });
      return;
    }

    if (session.userId.toString() !== userId) {
      res.status(403).json({ success: false, message: 'Forbidden' });
      return;
    }

    await ExerciseSession.findByIdAndDelete(id);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    console.error('[DELETE /exercise/:id]', err);
    res.status(500).json({ success: false, message: 'Failed to delete exercise session' });
  }
});

export default router;
