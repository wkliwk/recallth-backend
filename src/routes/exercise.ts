import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { ExerciseSession } from '../models/ExerciseSession';
import { MODELS } from '../config/models';
import { buildAiUsage } from '../utils/aiUsage';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

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
      status,
      activityType,
      activityLabel,
      date,
      durationMinutes,
      intensity,
      distanceKm,
      exercises,
      notes,
    } = req.body as {
      status?: unknown;
      activityType?: unknown;
      activityLabel?: unknown;
      date?: unknown;
      durationMinutes?: unknown;
      intensity?: unknown;
      distanceKm?: unknown;
      exercises?: unknown;
      notes?: unknown;
    };

    const isPlanned = status === 'planned';

    // Required field validation
    if (typeof activityType !== 'string' || activityType.trim().length === 0) {
      res.status(400).json({ success: false, message: 'activityType is required' });
      return;
    }

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ success: false, message: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    // duration and intensity required for completed; optional for planned
    if (!isPlanned) {
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
    }

    const sessionData: Record<string, unknown> = {
      userId,
      status: isPlanned ? 'planned' : 'completed',
      activityType: activityType.trim(),
      date,
      durationMinutes: typeof durationMinutes === 'number' && durationMinutes > 0 ? durationMinutes : 0,
      intensity: typeof intensity === 'string' ? intensity : 'moderate',
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

// ─── POST /exercise/parse — AI natural language parsing ──────────────────

router.post('/parse', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { text } = req.body as { text?: unknown };

    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'text is required' });
      return;
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const today = new Date().toISOString().slice(0, 10);

    const prompt = `You are a fitness assistant for Hong Kong users. Parse the following exercise/workout description and return structured data.
The input may be in English, Cantonese, or Traditional Chinese. Understand HK gym/sports culture context.

Exercise description: "${text.trim()}"
Today's date: ${today}

Return a JSON object with these fields:
- activityType: one of "gym", "running", "swimming", "basketball", "badminton", "cycling", "yoga", "hiking", "other"
- activityLabel: string (only if activityType is "other" — the specific activity name; omit otherwise)
- date: string in YYYY-MM-DD format (use today ${today} if not mentioned; interpret relative terms like "today", "yesterday", "今日", "尋日")
- durationMinutes: number (positive integer; estimate if not stated explicitly — e.g. a typical gym session is 60 min, a run is 30-45 min)
- intensity: one of "easy", "moderate", "hard" (infer from weights, pace, effort described; default "moderate")
- distanceKm: number (only for running/swimming/cycling/hiking if mentioned; omit otherwise)
- exercises: array of exercise sets (for gym or any activity with specific exercises). Each item has:
  - name: string (exercise name, keep original language)
  - type: one of "strength", "bodyweight", "timed", "cardio", "session"
    - "strength": barbell/dumbbell/machine with weight (bench press, squat, deadlift)
    - "bodyweight": sets × reps with no weight required (push-ups, pull-ups, sit-ups, dips)
    - "timed": held for time (plank 平板支撐, wall sit, dead hang, L-sit)
    - "cardio": distance + duration (running, cycling, rowing machine)
    - "session": duration only (yoga, stretching, general activity)
  - sets: number (for strength/bodyweight/timed)
  - reps: number (for strength/bodyweight only)
  - weightKg: number (for strength only; omit for bodyweight unless explicitly mentioned)
  - durationMin: number (for timed in minutes e.g. 30 sec = 0.5; for session in minutes)
  - distanceKm: number (for cardio only)
- notes: string (any extra context worth noting; omit if nothing relevant)

Rules:
- Always return valid JSON only — no markdown, no explanation
- durationMinutes must always be present and positive
- intensity must always be present
- activityType must always be present
- For gym: extract each exercise into the exercises array with correct type
- Plank/平板支撐 = timed type, not strength
- Push-ups/pull-ups/dips with no weight mentioned = bodyweight type

Examples:
Input: "今日做咗 bench press 3組10下80kg，deadlift 4組5下120kg，平板支撐5組30秒，gym 60分鐘"
{"activityType":"gym","date":"${today}","durationMinutes":60,"intensity":"moderate","exercises":[{"name":"bench press","type":"strength","sets":3,"reps":10,"weightKg":80},{"name":"deadlift","type":"strength","sets":4,"reps":5,"weightKg":120},{"name":"平板支撐","type":"timed","sets":5,"durationMin":0.5}]}

Input: "做咗100下掌上壓，4組pull-ups每組12下"
{"activityType":"gym","date":"${today}","durationMinutes":30,"intensity":"moderate","exercises":[{"name":"掌上壓","type":"bodyweight","sets":4,"reps":25},{"name":"pull-ups","type":"bodyweight","sets":4,"reps":12}]}

Input: "跑咗5公里，大概40分鐘，今日好攰所以行多過跑"
{"activityType":"running","date":"${today}","durationMinutes":40,"intensity":"easy","distanceKm":5}

Input: "打咗1個鐘羽毛球"
{"activityType":"badminton","date":"${today}","durationMinutes":60,"intensity":"moderate"}

Input: "做咗45分鐘瑜伽"
{"activityType":"yoga","date":"${today}","durationMinutes":45,"intensity":"easy","exercises":[{"name":"瑜伽","type":"session","durationMin":45}]}

Return ONLY valid JSON.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      console.error('[POST /exercise/parse] AI returned non-JSON:', raw);
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    // Basic validation
    if (typeof parsed.activityType !== 'string') {
      res.status(500).json({ success: false, data: null, error: 'AI parse missing activityType' });
      return;
    }
    if (typeof parsed.durationMinutes !== 'number' || (parsed.durationMinutes as number) <= 0) {
      parsed.durationMinutes = 60;
    }
    const validIntensities = ['easy', 'moderate', 'hard'];
    if (typeof parsed.intensity !== 'string' || !validIntensities.includes(parsed.intensity as string)) {
      parsed.intensity = 'moderate';
    }
    if (typeof parsed.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.date as string)) {
      parsed.date = today;
    }

    const usage = result.response.usageMetadata;
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=exercise-parse`);

    res.json({ success: true, data: parsed, aiUsage, error: null });
  } catch (err) {
    console.error('[POST /exercise/parse]', err);
    res.status(500).json({ success: false, data: null, error: 'AI exercise parsing failed' });
  }
});

export default router;
