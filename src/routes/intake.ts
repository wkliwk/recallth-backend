import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { IntakeLog } from '../models/IntakeLog';

const router = Router();

/** Returns today's date in YYYY-MM-DD UTC */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
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
    await IntakeLog.findOneAndUpdate(
      { userId: req.userId, date: today },
      { userId: req.userId, date: today },
      { upsert: true, new: true },
    );

    // Compute streaks from all logs
    const allLogs = await IntakeLog.find({ userId: req.userId }).sort({ date: 1 }).lean();
    const dates = allLogs.map((l) => l.date);
    const { currentStreak, longestStreak } = computeStreaks(dates);

    res.json({ date: today, currentStreak, longestStreak });
  } catch (error) {
    console.error('Intake log POST error:', error);
    res.status(500).json({ error: 'Failed to log intake' });
  }
});

// GET /intake/streak — return streak data
router.get('/streak', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const allLogs = await IntakeLog.find({ userId: req.userId }).sort({ date: 1 }).lean();
    const dates = allLogs.map((l) => l.date);
    const { currentStreak, longestStreak } = computeStreaks(dates);
    const lastLoggedDate = dates.length > 0 ? dates[dates.length - 1] : null;

    res.json({ currentStreak, longestStreak, lastLoggedDate });
  } catch (error) {
    console.error('Intake streak GET error:', error);
    res.status(500).json({ error: 'Failed to retrieve streak data' });
  }
});

export { router as intakeRouter };
