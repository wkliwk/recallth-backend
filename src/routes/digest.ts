import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { WeeklyDigest } from '../models/WeeklyDigest';
import { DailyLog } from '../models/DailyLog';
import { GoalCheckIn } from '../models/GoalCheckIn';
import { BloodworkEntry } from '../models/BloodworkEntry';
import { Conversation } from '../models/Conversation';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MODELS } from '../config/models';
import { buildAiUsage } from '../utils/aiUsage';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

const digestRouter = Router();

function getWeekBounds(weekKey?: string): { weekStart: Date; weekEnd: Date; weekKeyStr: string; weekEndStr: string } {
  let weekStart: Date;
  if (weekKey && /^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    weekStart = new Date(weekKey + 'T00:00:00.000Z');
    // Validate it's actually a Monday
    const day = weekStart.getUTCDay();
    if (day !== 1) {
      // Snap to closest Monday
      const diff = day === 0 ? -6 : 1 - day;
      weekStart.setUTCDate(weekStart.getUTCDate() + diff);
    }
  } else {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysToMonday);
    weekStart.setHours(0, 0, 0, 0);
  }
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const weekKeyStr = weekStart.toISOString().slice(0, 10);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);
  return { weekStart, weekEnd, weekKeyStr, weekEndStr };
}

// GET /digest?week=YYYY-MM-DD
digestRouter.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const { week } = req.query as { week?: string };
    const { weekStart, weekEnd, weekKeyStr, weekEndStr } = getWeekBounds(week);

    // 1. Return cached digest if available
    const cached = await WeeklyDigest.findOne({ userId, weekKey: weekKeyStr }).lean();
    if (cached) {
      res.json({ success: true, data: cached });
      return;
    }

    // 2. Aggregate stats for the week
    const [journalEntries, goalCheckIns, bloodworkEntries, conversations] = await Promise.all([
      DailyLog.find({
        userId,
        date: { $gte: weekKeyStr, $lte: weekEndStr },
      }).lean(),
      GoalCheckIn.find({
        userId,
        weekStart: weekKeyStr,
      }).lean(),
      BloodworkEntry.find({
        userId,
        date: { $gte: weekKeyStr, $lte: weekEndStr },
      }).lean(),
      Conversation.find({
        userId,
        createdAt: { $gte: weekStart, $lte: weekEnd },
      }).lean(),
    ]);

    const journalCount = journalEntries.length;
    const goalCount = goalCheckIns.length;

    // 3. Low-data check: fewer than 2 journal entries AND no goal ratings
    if (journalCount < 2 && goalCount === 0) {
      res.json({
        success: true,
        data: {
          weekKey: weekKeyStr,
          weekEnd: weekEndStr,
          summary: null,
          suggestion: null,
          stats: {
            avgMood: null,
            avgEnergy: null,
            goalLoggingRate: 0,
            bloodworkCount: bloodworkEntries.length,
            chatCount: conversations.length,
            journalCount,
          },
          insufficient: true,
          generatedAt: null,
        },
      });
      return;
    }

    // 4. Compute stats
    const avgMood = journalCount > 0
      ? Math.round((journalEntries.reduce((s, e) => s + e.mood, 0) / journalCount) * 10) / 10
      : null;
    const avgEnergy = journalCount > 0
      ? Math.round((journalEntries.reduce((s, e) => s + e.energy, 0) / journalCount) * 10) / 10
      : null;
    const goalLoggingRate = Math.round((journalCount / 7) * 100) / 100;
    const bloodworkCount = bloodworkEntries.length;
    const chatCount = conversations.length;

    const stats = { avgMood, avgEnergy, goalLoggingRate, bloodworkCount, chatCount, journalCount };

    // 5. Fetch profile + cabinet for prompt context
    const [profile, cabItems] = await Promise.all([
      HealthProfile.findOne({ userId }).lean(),
      CabinetItem.find({ userId, active: true }).lean(),
    ]);
    const supplementList = cabItems
      .map((i) => `${i.name}${i.dosage ? ` (${i.dosage})` : ''}`)
      .join(', ') || 'None tracked';
    const primaryGoal = (profile as { goals?: { primaryGoal?: string } } | null)?.goals?.primaryGoal ?? 'general wellness';
    const goalRatings = goalCheckIns.map((g) => `${g.goal}: ${g.rating}/5`).join(', ') || 'No goal check-ins';

    // 6. Call Gemini
    const prompt = `You are a supportive health advisor writing a brief weekly digest.

User's week (${weekKeyStr} to ${weekEndStr}):
- Journal entries: ${journalCount}/7 days
- Average mood: ${avgMood ?? 'N/A'}/5, Average energy: ${avgEnergy ?? 'N/A'}/5
- Goal check-ins: ${goalRatings}
- Bloodwork logged: ${bloodworkCount} entries
- AI chat sessions: ${chatCount}
- Active supplements: ${supplementList}
- Primary health goal: ${primaryGoal}

Write a concise weekly health digest. Return ONLY valid JSON (no markdown):
{
  "summary": string,   // 2-3 sentences: warm, encouraging overview of their week
  "suggestion": string // 1 specific, actionable suggestion for next week
}`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=weekly-digest`);
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

    let raw = result.response.text().trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(raw) as { summary: string; suggestion: string };

    // 7. Cache the result
    const digest = await WeeklyDigest.create({
      userId,
      weekKey: weekKeyStr,
      weekEnd: weekEndStr,
      summary: parsed.summary,
      suggestion: parsed.suggestion,
      stats,
      generatedAt: new Date(),
    });

    res.json({ success: true, data: { ...digest.toObject(), aiUsage } });
  } catch (err) {
    console.error('[GET /digest]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to generate digest' });
  }
});

export default digestRouter;
