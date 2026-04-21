import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { GoalCheckIn } from '../models/GoalCheckIn';
import { CabinetItem } from '../models/CabinetItem';
import { MODELS } from '../config/models';
import { buildAiUsage } from '../utils/aiUsage';

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
    let aiUsage: ReturnType<typeof buildAiUsage> | undefined;
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
      aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);
    } catch (aiErr) {
      console.error('[POST /goals/check-in] AI failed (non-fatal):', aiErr);
    }

    // Upsert the check-in
    const checkIn = await GoalCheckIn.findOneAndUpdate(
      { userId: userObjectId, goal: goal.trim(), weekStart },
      { rating, notes: notes?.trim(), aiResponse, weekStart },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: { checkIn, aiResponse, ...(aiUsage ? { aiUsage } : {}) }, error: null });
  } catch (err) {
    console.error('[POST /goals/check-in]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to save check-in' });
  }
});

// POST /goals/interpret
// Accepts natural language text and returns structured health goals extracted by AI
goalsRouter.post('/interpret', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const body = req.body as { text?: string };
    const { text } = body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a health goal interpreter. Extract health goals from the user's input text.
The input may be in any language (English, Cantonese, Traditional Chinese, etc.).

User input: "${text.trim()}"

Extract 1-5 distinct health goals. For each goal:
- name: a short, clear English name (2-4 words, e.g. "Build Muscle", "Improve Sleep", "Reduce Uric Acid", "Lose Weight", "Reduce Blood Sugar")
- emoji: a single relevant emoji

Return ONLY valid JSON, no markdown:
{ "goals": [{ "name": "...", "emoji": "..." }] }`;

    const result = await model.generateContent(prompt);
    let raw = result.response.text().trim();

    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(raw) as { goals: { name: string; emoji: string }[] };

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=goal-interpret`);

    res.json({ goals: parsed.goals });
  } catch (err) {
    console.error('[POST /goals/interpret]', err);
    res.status(500).json({ error: 'Failed to interpret goals' });
  }
});

// POST /goals/insights
// Given a goal name + optional notes, analyses the user's cabinet and returns
// which supplements support the goal, which are missing, and an AI summary.
goalsRouter.post('/insights', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const body = req.body as { goalName?: string; goalNotes?: string; language?: string };
    const { goalName, goalNotes, language } = body;
    const lang = (language === 'zh-HK' || language === 'zh-TW') ? language : 'en';

    if (!goalName || typeof goalName !== 'string' || goalName.trim().length === 0) {
      res.status(400).json({ error: 'goalName is required' });
      return;
    }

    const cabinetItems = await CabinetItem.find({
      userId: new Types.ObjectId(userId),
      active: true,
    }).lean();

    if (cabinetItems.length === 0) {
      res.json({
        supporting: [],
        missing: [],
        summary: 'Add supplements to your cabinet to see how they align with this goal.',
      });
      return;
    }

    const cabinetSummary = cabinetItems.map((i) => ({
      name: i.name,
      type: i.type,
      dosage: i.dosage,
    }));

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const langInstruction = lang === 'zh-HK'
      ? 'Respond in natural conversational Cantonese (廣東話) using particles like 係、唔、嘅、喺、囉. All "reason" and "summary" fields must be in Cantonese.'
      : lang === 'zh-TW'
      ? 'Respond in Traditional Chinese (繁體中文). All "reason" and "summary" fields must be in Traditional Chinese.'
      : 'Respond in English.';

    const prompt = `You are a supplement advisor. Analyse how the user's supplement cabinet aligns with their health goal.

Goal: "${goalName.trim()}"
${goalNotes ? `Goal notes: "${goalNotes.trim()}"` : ''}

User's cabinet:
${JSON.stringify(cabinetSummary, null, 2)}

Language instruction: ${langInstruction}

Return ONLY valid JSON, no markdown:
{
  "supporting": [{ "name": "...", "reason": "..." }],
  "missing": [{ "name": "...", "reason": "..." }],
  "summary": "..."
}

Rules:
- supporting: cabinet items that directly help this goal (max 5)
- missing: supplements NOT in the cabinet that would meaningfully help (max 4, evidence-based)
- summary: 1–2 sentences about the user's current stack vs this goal
- Only include items in "supporting" that are in the cabinet list above
- Be specific about why each supplement helps`;

    let raw: string;
    try {
      const result = await model.generateContent(prompt);
      raw = result.response.text().trim();

      const usage = result.response.usageMetadata;
      console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=goal-insights`);
    } catch (aiErr) {
      console.error('[POST /goals/insights] AI call failed:', aiErr);
      res.status(500).json({ error: 'Failed to generate insights' });
      return;
    }

    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: {
      supporting: { name: string; reason: string }[];
      missing: { name: string; reason: string }[];
      summary: string;
    };

    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch (parseErr) {
      console.error('[POST /goals/insights] JSON parse failed:', parseErr, 'raw:', raw);
      res.status(500).json({ error: 'Failed to generate insights' });
      return;
    }

    res.json({
      supporting: parsed.supporting,
      missing: parsed.missing,
      summary: parsed.summary,
    });
  } catch (err) {
    console.error('[POST /goals/insights]', err);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});
