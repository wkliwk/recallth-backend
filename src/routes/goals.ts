import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { GoalCheckIn } from '../models/GoalCheckIn';
import { MODELS } from '../config/models';

export const goalsRouter = Router();
goalsRouter.use(authenticate);

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

/** Returns the ISO date string (YYYY-MM-DD) of the Monday for the given date */
function getWeekStart(date: Date = new Date()): string {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

// GET /goals/check-ins
// Returns all check-ins for the authenticated user (last 8 weeks), sorted descending
goalsRouter.get('/check-ins', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
    const since = eightWeeksAgo.toISOString().slice(0, 10);

    const checkIns = await GoalCheckIn.find({
      userId: new Types.ObjectId(userId),
      weekStart: { $gte: since },
    }).sort({ weekStart: -1 }).lean();

    res.json({ success: true, data: checkIns, error: null });
  } catch (err) {
    console.error('[GET /goals/check-ins]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to load check-ins' });
  }
});

// POST /goals/check-in
// Upserts a weekly check-in for a goal, then generates a 1-sentence AI response
goalsRouter.post('/check-in', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const body = req.body as { goal?: string; rating?: number; notes?: string };
    const { goal, rating, notes } = body;

    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'goal is required' });
      return;
    }
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      res.status(400).json({ success: false, data: null, error: 'rating must be 1-5' });
      return;
    }

    const weekStart = getWeekStart();
    const userObjectId = new Types.ObjectId(userId);

    // Fetch recent history for AI context (last 8 weeks)
    const eightWeeksAgo = new Date();
    eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
    const since = eightWeeksAgo.toISOString().slice(0, 10);

    const history = await GoalCheckIn.find({
      userId: userObjectId,
      goal: goal.trim(),
      weekStart: { $gte: since },
    }).sort({ weekStart: 1 }).lean();

    // Generate AI response
    let aiResponse: string | undefined;
    try {
      const genAI = getGenAI();
      const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

      const historyStr = history.length > 0
        ? history.map((h) => `Week of ${h.weekStart}: rating ${h.rating}/5${h.notes ? `, notes: "${h.notes}"` : ''}`).join('\n')
        : 'No previous check-ins';

      const prompt = `You are a supportive health coach. A user just checked in on their goal: "${goal.trim()}".\n\nThis week's rating: ${rating}/5${notes ? `\nNotes: "${notes}"` : ''}\n\nRecent history:\n${historyStr}\n\nRespond with exactly ONE encouraging sentence (under 25 words) that references their current rating and recent trend. Be warm and specific. No generic filler.`;

      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      aiResponse = text.split('\n')[0].trim();

      const usage = result.response.usageMetadata;
      console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=goal-check-in`);
    } catch (aiErr) {
      console.error('[POST /goals/check-in] AI failed (non-fatal):', aiErr);
    }

    // Upsert the check-in
    const checkIn = await GoalCheckIn.findOneAndUpdate(
      { userId: userObjectId, goal: goal.trim(), weekStart },
      { rating, notes: notes?.trim(), aiResponse, weekStart },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: { checkIn, aiResponse }, error: null });
  } catch (err) {
    console.error('[POST /goals/check-in]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to save check-in' });
  }
});
