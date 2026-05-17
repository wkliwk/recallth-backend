import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { IntakeLog } from '../models/IntakeLog';
import { DoseLog } from '../models/DoseLog';
import { DoseEffect } from '../models/DoseEffect';
import { UserSettings } from '../models/UserSettings';

const router = Router();

const FREEZE_TOKEN_CAP = 2;
const FREEZE_GRANT_INTERVAL = 14; // grant 1 token every N days of streak

/** Returns today's date in YYYY-MM-DD UTC */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Returns yesterday's date in YYYY-MM-DD UTC */
function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Compute currentStreak and longestStreak from a sorted (asc) list of YYYY-MM-DD date strings */
export function computeStreaks(dates: string[]): { currentStreak: number; longestStreak: number } {
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  // Compute longest streak by iterating through sorted dates
  let longestStreak = 1;
  let runLength = 1;
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1] + 'T00:00:00Z');
    const curr = new Date(dates[i] + 'T00:00:00Z');
    const diffDays = Math.round((curr.getTime() - prev.getTime()) / 86400000);
    if (diffDays === 1) {
      runLength += 1;
      if (runLength > longestStreak) longestStreak = runLength;
    } else {
      runLength = 1;
    }
  }

  // Compute current streak: count backwards from today (or yesterday)
  const today = todayUTC();
  const yesterday = new Date(today + 'T00:00:00Z');
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const dateSet = new Set(dates);
  const anchor = dateSet.has(today) ? today : dateSet.has(yesterdayStr) ? yesterdayStr : null;

  let currentStreak = 0;
  if (anchor) {
    let cursor = new Date(anchor + 'T00:00:00Z');
    while (dateSet.has(cursor.toISOString().slice(0, 10))) {
      currentStreak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }

  return { currentStreak, longestStreak };
}

// POST /intake/log — mark today as taken (idempotent)
router.post('/log', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const today = todayUTC();
    const userId = req.userId!;

    await IntakeLog.findOneAndUpdate(
      { userId, date: today },
      { userId, date: today },
      { upsert: true, new: true },
    );

    // Compute streaks from all logs
    const allLogs = await IntakeLog.find({ userId }).sort({ date: 1 }).lean();
    const dates = allLogs.map((l) => l.date);
    const { currentStreak, longestStreak } = computeStreaks(dates);

    // Grant freeze token at every FREEZE_GRANT_INTERVAL-day milestone (idempotent via lastFreezeGrantedStreak)
    let freezeGranted = false;
    let settings = await UserSettings.findOne({ userId }).lean();
    const currentTokens = settings?.freezeTokens ?? 0;
    const lastGrantedStreak = settings?.lastFreezeGrantedStreak ?? 0;

    if (
      currentStreak > 0 &&
      currentStreak % FREEZE_GRANT_INTERVAL === 0 &&
      currentStreak !== lastGrantedStreak &&
      currentTokens < FREEZE_TOKEN_CAP
    ) {
      await UserSettings.findOneAndUpdate(
        { userId },
        {
          $inc: { freezeTokens: 1 },
          $set: { lastFreezeGrantedStreak: currentStreak },
        },
        { upsert: true },
      );
      freezeGranted = true;
    }

    const finalTokens = freezeGranted ? currentTokens + 1 : currentTokens;

    res.json({ date: today, currentStreak, longestStreak, freezeGranted, freezeTokens: finalTokens });
  } catch (error) {
    console.error('Intake log POST error:', error);
    res.status(500).json({ error: 'Failed to log intake' });
  }
});

// GET /intake/status — check if user has logged today
router.get('/status', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const today = todayUTC();
    const log = await IntakeLog.findOne({ userId: req.userId, date: today }).lean();
    res.json({ logged: !!log, loggedAt: log ? log.createdAt : null });
  } catch (error) {
    console.error('Intake status GET error:', error);
    res.status(500).json({ error: 'Failed to retrieve intake status' });
  }
});

// GET /intake/streak — return streak data including freeze token count
router.get('/streak', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const [allLogs, settings] = await Promise.all([
      IntakeLog.find({ userId }).sort({ date: 1 }).lean(),
      UserSettings.findOne({ userId }).lean(),
    ]);
    const dates = allLogs.map((l) => l.date);
    const { currentStreak, longestStreak } = computeStreaks(dates);
    const lastLoggedDate = dates.length > 0 ? dates[dates.length - 1] : null;

    res.json({
      currentStreak,
      longestStreak,
      lastLoggedDate,
      freezeTokens: settings?.freezeTokens ?? 0,
    });
  } catch (error) {
    console.error('Intake streak GET error:', error);
    res.status(500).json({ error: 'Failed to retrieve streak data' });
  }
});

// POST /intake/apply-freeze — auto-consume a freeze token when yesterday was missed
// Adds a retroactive IntakeLog for yesterday, preserving the streak.
router.post('/apply-freeze', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const yesterday = yesterdayUTC();

    const [settings, yesterdayLog] = await Promise.all([
      UserSettings.findOne({ userId }).lean(),
      IntakeLog.findOne({ userId, date: yesterday }).lean(),
    ]);

    if (!settings || (settings.freezeTokens ?? 0) <= 0) {
      res.status(400).json({ success: false, error: 'No freeze tokens available' });
      return;
    }

    if (yesterdayLog) {
      // Yesterday already logged — no freeze needed
      res.status(400).json({ success: false, error: 'Yesterday was already logged — no freeze needed' });
      return;
    }

    // Add retroactive intake log for yesterday
    await IntakeLog.findOneAndUpdate(
      { userId, date: yesterday },
      { userId, date: yesterday },
      { upsert: true, new: true },
    );

    // Decrement token
    await UserSettings.findOneAndUpdate(
      { userId },
      { $inc: { freezeTokens: -1 } },
    );

    // Recompute streak
    const allLogs = await IntakeLog.find({ userId }).sort({ date: 1 }).lean();
    const dates = allLogs.map((l) => l.date);
    const { currentStreak } = computeStreaks(dates);
    const tokensLeft = Math.max(0, (settings.freezeTokens ?? 0) - 1);

    res.json({ success: true, streak: currentStreak, tokensLeft });
  } catch (error) {
    console.error('Intake apply-freeze POST error:', error);
    res.status(500).json({ error: 'Failed to apply streak freeze' });
  }
});

// POST /intake/effect — rate how you felt after a dose (upsert by doseLogId)
router.post('/effect', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.userId);
    const { doseLogId, supplementId, supplementName, energy, focus, sleep, mood } = req.body as {
      doseLogId?: string;
      supplementId?: string;
      supplementName?: string;
      energy?: unknown;
      focus?: unknown;
      sleep?: unknown;
      mood?: unknown;
    };

    // Validate required fields
    if (!doseLogId || !Types.ObjectId.isValid(doseLogId)) {
      res.status(400).json({ success: false, data: null, error: 'doseLogId is required and must be a valid ObjectId' });
      return;
    }
    if (!supplementId || !Types.ObjectId.isValid(supplementId)) {
      res.status(400).json({ success: false, data: null, error: 'supplementId is required and must be a valid ObjectId' });
      return;
    }
    if (!supplementName || typeof supplementName !== 'string' || supplementName.trim() === '') {
      res.status(400).json({ success: false, data: null, error: 'supplementName is required' });
      return;
    }

    // Validate that the dose log exists and belongs to this user
    const doseLog = await DoseLog.findOne({ _id: new Types.ObjectId(doseLogId), userId }).lean();
    if (!doseLog) {
      res.status(404).json({ success: false, data: null, error: 'Dose log not found or does not belong to this user' });
      return;
    }

    // Validate rating values (optional but must be 1–5 if provided)
    const ratings: { energy?: number; focus?: number; sleep?: number; mood?: number } = {};
    const ratingFields = { energy, focus, sleep, mood } as Record<string, unknown>;
    for (const [field, value] of Object.entries(ratingFields)) {
      if (value !== undefined && value !== null) {
        const num = Number(value);
        if (isNaN(num) || num < 1 || num > 5 || !Number.isInteger(num)) {
          res.status(400).json({ success: false, data: null, error: `${field} must be an integer between 1 and 5` });
          return;
        }
        (ratings as Record<string, number>)[field] = num;
      }
    }

    // Upsert by doseLogId — allow re-rating the same dose
    const effect = await DoseEffect.findOneAndUpdate(
      { doseLogId: new Types.ObjectId(doseLogId) },
      {
        $set: {
          userId,
          supplementId: new Types.ObjectId(supplementId),
          supplementName: supplementName.trim(),
          ratedAt: new Date(),
          ...ratings,
        },
      },
      { upsert: true, new: true }
    );

    res.status(200).json({ success: true, data: effect, error: null });
  } catch (error) {
    console.error('Intake effect POST error:', error);
    res.status(500).json({ success: false, data: null, error: 'Failed to save effect rating' });
  }
});

export { router as intakeRouter };
