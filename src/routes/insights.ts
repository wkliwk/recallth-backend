import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { InsightCache } from '../models/InsightCache';
import { DailyLog } from '../models/DailyLog';
import { SideEffect } from '../models/SideEffect';
import { BloodworkEntry } from '../models/BloodworkEntry';
import { CabinetItem } from '../models/CabinetItem';
import { HealthProfile } from '../models/HealthProfile';
import { MODELS } from '../config/models';
import { buildAiUsage } from '../utils/aiUsage';

const router = Router();
router.use(authenticate);

const BRIEF_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BRIEF_TYPE = 'daily-brief';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

// POST /insights/daily-brief
// Returns a cached brief if fresh (<24h), otherwise generates a new one.
router.post('/daily-brief', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const userObjectId = new Types.ObjectId(userId);
    const forceRefresh = (req.body as { forceRefresh?: boolean })?.forceRefresh === true;

    // Check cache
    const cached = await InsightCache.findOne({ userId: userObjectId, type: BRIEF_TYPE }).lean();
    const now = Date.now();
    const isFresh = cached && (now - cached.generatedAt.getTime()) < BRIEF_TTL_MS;

    if (isFresh && !forceRefresh) {
      res.json({
        success: true,
        data: {
          brief: cached.content,
          generatedAt: cached.generatedAt.toISOString(),
          fromCache: true,
        },
        error: null,
      });
      return;
    }

    // Enforce 24h rate limit on forced regeneration
    if (forceRefresh && cached && isFresh) {
      const ageMs = now - cached.generatedAt.getTime();
      const retryAfterMs = BRIEF_TTL_MS - ageMs;
      res.status(429).json({
        success: false,
        data: {
          brief: cached.content,
          generatedAt: cached.generatedAt.toISOString(),
          fromCache: true,
          rateLimited: true,
          retryAfterMs,
        },
        error: 'Brief was generated less than 24 hours ago. Try again later.',
      });
      return;
    }

    // Gather data
    const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    const [journalLogs, sideEffects, bloodworkEntries, cabinetItems, profile] = await Promise.all([
      DailyLog.find({ userId: userObjectId, date: { $gte: fourteenDaysAgo.toISOString().slice(0, 10) } }).sort({ date: -1 }).lean(),
      SideEffect.find({ userId: userObjectId }).sort({ date: -1 }).limit(20).lean(),
      BloodworkEntry.find({ userId: userObjectId }).sort({ date: -1 }).limit(10).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
      HealthProfile.findOne({ userId: userObjectId }).lean(),
    ]);

    // Check trigger conditions
    const hasEnoughData =
      journalLogs.length >= 7 ||
      bloodworkEntries.length >= 1 ||
      sideEffects.length >= 3;

    if (!hasEnoughData) {
      res.json({
        success: true,
        data: {
          brief: null,
          generatedAt: null,
          fromCache: false,
          insufficientData: true,
        },
        error: null,
      });
      return;
    }

    // Build context
    const journalSummary = journalLogs.slice(0, 7).map((log) => {
      const parts: string[] = [`${log.date}:`];
      if (log.mood !== undefined) parts.push(`mood ${log.mood}/5`);
      if (log.energy !== undefined) parts.push(`energy ${log.energy}/5`);
      // DailyLog has no sleep field
      if (log.notes) parts.push(`notes: "${log.notes.slice(0, 80)}"`);
      return parts.join(' ');
    }).join('\n');

    const sideEffectSummary = sideEffects.slice(0, 10).map((se) => {
      return `${se.date}: ${se.symptom} (severity ${se.rating}/5)`;
    }).join('\n') || 'None logged';

    const bloodworkSummary = bloodworkEntries.length > 0
      ? bloodworkEntries.map((e) => `${e.marker}: ${e.value} ${e.unit} (${e.date})`).join(', ')
      : 'None logged';

    const supplementList = cabinetItems.length > 0
      ? cabinetItems.map((i) => i.name + (i.dosage ? ` ${i.dosage}` : '')).join(', ')
      : 'None';

    const goals = profile?.goals?.primary?.join(', ') || 'Not specified';

    const prompt = `You are a personalised health advisor for a user of Recallth, a supplement and wellness tracking app.

Here is the user's recent data:

Journal (last 14 days):
${journalSummary || 'No journal entries'}

Recent side effects:
${sideEffectSummary}

Recent bloodwork:
${bloodworkSummary}

Current supplements: ${supplementList}
Health goals: ${goals}

Write a personalised Daily Brief for this user. It should be 3–5 sentences that:
1. Reference at least one specific data point (e.g. a mood trend, a side effect pattern, or a bloodwork value)
2. Offer one specific, actionable suggestion connected to their supplements or habits
3. Be encouraging and non-alarmist in tone

Return ONLY the brief text — no JSON, no headings, no markdown. Write it as if speaking directly to the user.
This is general health information, not personalised medical advice.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=daily-brief`
    );

    const brief = result.response.text().trim();
    const briefUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

    // Cache the result (upsert)
    const generatedAt = new Date();
    await InsightCache.findOneAndUpdate(
      { userId: userObjectId, type: BRIEF_TYPE },
      { content: brief, generatedAt },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      data: {
        brief,
        generatedAt: generatedAt.toISOString(),
        fromCache: false,
        aiUsage: briefUsage,
      },
      error: null,
    });
  } catch (err) {
    console.error('[POST /insights/daily-brief]', err);
    res.status(500).json({ success: false, data: null, error: 'Daily brief generation failed' });
  }
});


const JOURNAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const JOURNAL_INSIGHTS_TYPE = 'journal-insights';

// POST /insights/journal-insights
// Returns cached insights if fresh (<24h), otherwise generates new ones.
router.post('/journal-insights', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const userObjectId = new Types.ObjectId(userId);
    const forceRefresh = (req.body as { forceRefresh?: boolean })?.forceRefresh === true;

    // Check cache
    const cached = await InsightCache.findOne({ userId: userObjectId, type: JOURNAL_INSIGHTS_TYPE }).lean();
    const now = Date.now();
    const isFresh = cached && (now - cached.generatedAt.getTime()) < JOURNAL_TTL_MS;

    if (isFresh && !forceRefresh) {
      let insights: string[] = [];
      try { insights = JSON.parse(cached.content) as string[]; } catch { insights = [cached.content]; }
      res.json({ success: true, data: { insights, generatedAt: cached.generatedAt.toISOString(), fromCache: true }, error: null });
      return;
    }

    if (forceRefresh && cached && isFresh) {
      const ageMs = now - cached.generatedAt.getTime();
      const retryAfterMs = JOURNAL_TTL_MS - ageMs;
      let insights: string[] = [];
      try { insights = JSON.parse(cached.content) as string[]; } catch { insights = [cached.content]; }
      res.status(429).json({
        success: false,
        data: { insights, generatedAt: cached.generatedAt.toISOString(), retryAfterMs },
        error: 'Rate limited — try again later',
      });
      return;
    }

    // Fetch last 30 days of journal entries
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [logs, cabinet] = await Promise.all([
      DailyLog.find({ userId: userObjectId, date: { $gte: thirtyDaysAgo } }).sort({ date: 1 }).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
    ]);

    // Minimum data check: 5 entries required
    if (logs.length < 5) {
      res.json({ success: true, data: { insights: [], generatedAt: new Date().toISOString(), insufficientData: true }, error: null });
      return;
    }

    const journalSummary = logs.map((l) => {
      const d = new Date(l.date).toISOString().slice(0, 10);
      const parts = [`${d}: mood=${l.mood ?? '?'}/5 energy=${l.energy ?? '?'}/5`];
      if (l.notes) parts.push(`notes="${l.notes.slice(0, 80)}"`);
      return parts.join(' ');
    }).join('\n');

    const cabinetText = cabinet.length > 0
      ? cabinet.map((c) => `${c.name}${c.dosage ? ` ${c.dosage}` : ''}${c.frequency ? ` (${c.frequency})` : ''}`).join(', ')
      : 'None';

    const prompt = `You are a health pattern analyst. Analyse the following journal data and return 2–3 specific, plain-language observations.

Journal entries (last 30 days):
${journalSummary}

Active supplements: ${cabinetText}

Rules:
- Each insight must reference specific data (e.g. dates, score values, supplement names)
- Do NOT make diagnoses or medical claims
- Keep each insight to 1–2 sentences
- Return ONLY valid JSON array of strings, no markdown:
["insight 1", "insight 2", "insight 3"]`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let insights: string[];
    try {
      insights = JSON.parse(cleaned) as string[];
      if (!Array.isArray(insights)) throw new Error('not array');
      insights = insights.filter((s) => typeof s === 'string' && s.trim()).slice(0, 3);
    } catch {
      insights = [cleaned];
    }

    const generatedAt = new Date();
    await InsightCache.findOneAndUpdate(
      { userId: userObjectId, type: JOURNAL_INSIGHTS_TYPE },
      { content: JSON.stringify(insights), generatedAt },
      { upsert: true, new: true }
    );

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=journal-insights`);
    const journalUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

    res.json({ success: true, data: { insights, generatedAt: generatedAt.toISOString(), fromCache: false, aiUsage: journalUsage }, error: null });
  } catch (err) {
    console.error('[POST /insights/journal-insights]', err);
    res.status(500).json({ success: false, data: null, error: 'Journal insights generation failed' });
  }
});

export { router as insightsRouter };
