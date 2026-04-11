import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { DoseLog } from '../models/DoseLog';

const router = Router();
router.use(authenticate);

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// POST /schedule/log-dose — record a dose taken
router.post('/log-dose', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const { supplementId, supplementName, slot, takenAt } = req.body as {
      supplementId?: unknown;
      supplementName?: unknown;
      slot?: unknown;
      takenAt?: unknown;
    };

    if (!supplementId || !Types.ObjectId.isValid(String(supplementId))) {
      res.status(400).json({ success: false, data: null, error: 'supplementId must be a valid ObjectId' });
      return;
    }
    if (typeof supplementName !== 'string' || !supplementName.trim()) {
      res.status(400).json({ success: false, data: null, error: 'supplementName is required' });
      return;
    }

    const takenAtDate = takenAt ? new Date(String(takenAt)) : new Date();
    if (isNaN(takenAtDate.getTime())) {
      res.status(400).json({ success: false, data: null, error: 'takenAt must be a valid ISO timestamp' });
      return;
    }

    const log = await DoseLog.create({
      userId: new Types.ObjectId(userId),
      supplementId: new Types.ObjectId(String(supplementId)),
      supplementName: supplementName.trim(),
      slot: typeof slot === 'string' ? slot : '',
      takenAt: takenAtDate,
    });

    res.status(201).json({ success: true, data: log, error: null });
  } catch (err) {
    console.error('[POST /schedule/log-dose]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to log dose' });
  }
});

// DELETE /schedule/log-dose/:id — undo a dose log
router.delete('/log-dose/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const id = String(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, data: null, error: 'Invalid log id' });
      return;
    }

    const deleted = await DoseLog.findOneAndDelete({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });

    if (!deleted) {
      res.status(404).json({ success: false, data: null, error: 'Dose log not found' });
      return;
    }

    res.json({ success: true, data: null, error: null });
  } catch (err) {
    console.error('[DELETE /schedule/log-dose]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to delete dose log' });
  }
});

// GET /schedule/dose-logs?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/dose-logs', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const { from, to } = req.query as { from?: string; to?: string };

    const filter: {
      userId: Types.ObjectId;
      takenAt?: { $gte?: Date; $lte?: Date };
    } = { userId: new Types.ObjectId(userId) };

    if (from || to) {
      filter.takenAt = {};
      if (from && DATE_REGEX.test(from)) {
        filter.takenAt.$gte = new Date(from + 'T00:00:00.000Z');
      }
      if (to && DATE_REGEX.test(to)) {
        filter.takenAt.$lte = new Date(to + 'T23:59:59.999Z');
      }
    }

    const logs = await DoseLog.find(filter).sort({ takenAt: -1 }).lean();
    res.json({ success: true, data: logs, error: null });
  } catch (err) {
    console.error('[GET /schedule/dose-logs]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to fetch dose logs' });
  }
});

export { router as scheduleRouter };
