import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { ExerciseSession } from '../models/ExerciseSession';
import { HealthProfile } from '../models/HealthProfile';
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

// ─── POST /exercise/ai-plan — AI generates tomorrow's workout ────────────────

router.post('/ai-plan', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;

    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const historyDateStr = fourteenDaysAgo.toISOString().slice(0, 10);

    const [recentSessions, profile] = await Promise.all([
      ExerciseSession.find({ userId, date: { $gte: historyDateStr }, status: 'completed' })
        .sort({ date: -1 })
        .lean(),
      HealthProfile.findOne({ userId }).lean(),
    ]);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const historyLines = recentSessions.map((s) => {
      const parts = [`${s.date}: ${s.activityType}`];
      if (s.durationMinutes) parts.push(`${s.durationMinutes} min`);
      if (s.intensity) parts.push(`intensity: ${s.intensity}`);
      if (s.distanceKm) parts.push(`${s.distanceKm}km`);
      return parts.join(', ');
    });

    const goalParts: string[] = [];
    if (profile?.exercise?.goals?.length) {
      goalParts.push(`Exercise goals: ${profile.exercise.goals.join(', ')}`);
    }
    if (profile?.trainingGoals?.length) {
      goalParts.push(`Training goals: ${profile.trainingGoals.map((g) => g.description).join(', ')}`);
    }
    if (profile?.exercise?.frequency) {
      goalParts.push(`Workout frequency: ${profile.exercise.frequency}`);
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a personal fitness coach for a Hong Kong user. Based on their recent exercise history and fitness goals, generate a personalised workout plan for tomorrow (${tomorrowStr}).

RECENT EXERCISE HISTORY (last 14 days):
${historyLines.length > 0 ? historyLines.join('\n') : 'No recent sessions recorded.'}

USER GOALS:
${goalParts.length > 0 ? goalParts.join('\n') : 'No specific goals set.'}

INSTRUCTIONS:
- Recommend 1–3 exercise sessions for tomorrow
- Consider recovery: avoid same muscle groups trained at high intensity today/yesterday
- Balance variety with the user's existing habits
- Keep it realistic — don't over-programme
- Add a brief note in Cantonese (Traditional Chinese) explaining why this is recommended
- For gym sessions: always include an exercises array with 3–6 specific movements

Return a JSON array. Each item has:
- activityType: one of "gym", "running", "swimming", "basketball", "badminton", "cycling", "yoga", "hiking", "other"
- durationMinutes: number (positive integer)
- intensity: one of "easy", "moderate", "hard"
- notes: string (brief Cantonese explanation)
- exercises: array (REQUIRED for gym; optional for other types). Each exercise:
  - name: string (exercise name in English or Chinese)
  - type: one of "strength", "bodyweight", "timed", "cardio", "session"
  - sets: number (for strength/bodyweight/timed)
  - reps: number (for strength/bodyweight)
  - weightKg: number (for strength — suggest realistic starting weight)
  - durationMin: number (for timed, in minutes; e.g. 30 sec = 0.5)

Exercise type rules:
- Barbell/dumbbell/machine with weight → "strength"
- Push-ups, pull-ups, dips, bodyweight squats → "bodyweight"
- Plank, wall sit, dead hang → "timed"
- Running on treadmill, rowing machine → "cardio"
- Yoga, stretching session → "session"

Example gym session:
{"activityType":"gym","durationMinutes":60,"intensity":"moderate","notes":"上身推拉訓練","exercises":[{"name":"Bench Press","type":"strength","sets":3,"reps":10,"weightKg":60},{"name":"Pull-ups","type":"bodyweight","sets":3,"reps":8},{"name":"Shoulder Press","type":"strength","sets":3,"reps":12,"weightKg":40},{"name":"平板支撐","type":"timed","sets":3,"durationMin":0.5}]}

Example running session:
{"activityType":"running","durationMinutes":30,"intensity":"easy","notes":"輕鬆跑步幫助恢復"}

Return ONLY valid JSON array. No markdown, no explanation.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let sessions: unknown[];
    try {
      sessions = JSON.parse(cleaned) as unknown[];
      if (!Array.isArray(sessions)) throw new Error('not an array');
    } catch {
      console.error('[POST /exercise/ai-plan] AI returned non-JSON:', raw);
      res.status(500).json({ success: false, message: 'AI returned unexpected format' });
      return;
    }

    const validActivityTypes = ['gym', 'running', 'swimming', 'basketball', 'badminton', 'cycling', 'yoga', 'hiking', 'other'];
    const validIntensities = ['easy', 'moderate', 'hard'];
    const validExTypes = ['strength', 'bodyweight', 'timed', 'cardio', 'session'];

    const sanitized = sessions
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
      .map((s) => {
        const base: Record<string, unknown> = {
          activityType: validActivityTypes.includes(s.activityType as string) ? (s.activityType as string) : 'gym',
          durationMinutes: typeof s.durationMinutes === 'number' && (s.durationMinutes as number) > 0 ? (s.durationMinutes as number) : 60,
          intensity: validIntensities.includes(s.intensity as string) ? (s.intensity as string) : 'moderate',
        };
        if (typeof s.notes === 'string' && (s.notes as string).trim().length > 0) {
          base.notes = (s.notes as string).trim();
        }
        if (Array.isArray(s.exercises) && s.exercises.length > 0) {
          base.exercises = (s.exercises as Record<string, unknown>[])
            .filter((ex) => typeof ex.name === 'string' && ex.name.trim().length > 0)
            .map((ex) => {
              const type = validExTypes.includes(ex.type as string) ? (ex.type as string) : 'strength';
              const exOut: Record<string, unknown> = { name: (ex.name as string).trim(), type };
              if (typeof ex.sets === 'number' && ex.sets > 0) exOut.sets = ex.sets;
              if (typeof ex.reps === 'number' && ex.reps > 0) exOut.reps = ex.reps;
              if (typeof ex.weightKg === 'number' && ex.weightKg > 0) exOut.weightKg = ex.weightKg;
              if (typeof ex.durationMin === 'number' && ex.durationMin > 0) exOut.durationMin = ex.durationMin;
              if (typeof ex.distanceKm === 'number' && ex.distanceKm > 0) exOut.distanceKm = ex.distanceKm;
              return exOut;
            });
        }
        return base;
      });

    if (sanitized.length === 0) {
      res.status(500).json({ success: false, message: 'AI returned empty plan' });
      return;
    }

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=exercise-ai-plan`);

    res.json({ success: true, data: { date: tomorrowStr, sessions: sanitized } });
  } catch (err) {
    console.error('[POST /exercise/ai-plan]', err);
    res.status(500).json({ success: false, message: 'Failed to generate AI workout plan' });
  }
});

// ─── POST /exercise/bulk — create multiple sessions at once ──────────────────

router.post('/bulk', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { sessions } = req.body as { sessions?: unknown };

    if (!Array.isArray(sessions) || sessions.length === 0) {
      res.status(400).json({ success: false, message: 'sessions must be a non-empty array' });
      return;
    }
    if (sessions.length > 10) {
      res.status(400).json({ success: false, message: 'Cannot bulk create more than 10 sessions at once' });
      return;
    }

    const validActivityTypes = ['gym', 'running', 'swimming', 'basketball', 'badminton', 'cycling', 'yoga', 'hiking', 'other'];
    const validIntensities = ['easy', 'moderate', 'hard'] as const;

    const toCreate: Record<string, unknown>[] = [];

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i] as Record<string, unknown>;

      if (typeof s.activityType !== 'string' || !validActivityTypes.includes(s.activityType)) {
        res.status(400).json({ success: false, message: `Session ${i}: invalid activityType` });
        return;
      }
      if (typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
        res.status(400).json({ success: false, message: `Session ${i}: date must be YYYY-MM-DD` });
        return;
      }
      if (typeof s.durationMinutes !== 'number' || (s.durationMinutes as number) <= 0) {
        res.status(400).json({ success: false, message: `Session ${i}: durationMinutes must be a positive number` });
        return;
      }
      if (typeof s.intensity !== 'string' || !validIntensities.includes(s.intensity as typeof validIntensities[number])) {
        res.status(400).json({ success: false, message: `Session ${i}: intensity must be easy/moderate/hard` });
        return;
      }

      const doc: Record<string, unknown> = {
        userId,
        status: s.status === 'planned' ? 'planned' : 'completed',
        activityType: s.activityType,
        date: s.date,
        durationMinutes: s.durationMinutes,
        intensity: s.intensity,
      };
      if (typeof s.notes === 'string' && (s.notes as string).trim().length > 0) {
        doc.notes = (s.notes as string).trim();
      }
      if (typeof s.activityLabel === 'string' && (s.activityLabel as string).trim().length > 0) {
        doc.activityLabel = (s.activityLabel as string).trim();
      }
      if (Array.isArray(s.exercises) && s.exercises.length > 0) {
        doc.exercises = s.exercises;
      }

      toCreate.push(doc);
    }

    const created = await ExerciseSession.insertMany(toCreate);
    res.status(201).json({ success: true, data: created });
  } catch (err) {
    console.error('[POST /exercise/bulk]', err);
    res.status(500).json({ success: false, message: 'Failed to bulk create exercise sessions' });
  }
});

// ─── POST /exercise/:id/analyze — inline AI analysis of a session ─────────────

router.post('/:id/analyze', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { id } = req.params;
    const sessionId = Array.isArray(id) ? id[0] : id;
    if (!Types.ObjectId.isValid(sessionId)) {
      res.status(400).json({ success: false, message: 'Invalid session ID' });
      return;
    }

    const session = await ExerciseSession.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }

    // Build session summary for the prompt
    const intensityMap: Record<string, string> = { easy: '輕鬆', moderate: '中等', hard: '高強度' };
    const activityMap: Record<string, string> = {
      gym: '健身室', running: '跑步', swimming: '游泳', basketball: '籃球',
      badminton: '羽毛球', cycling: '單車', yoga: '瑜伽', hiking: '行山', other: '其他',
    };

    const sessionSummary = [
      `日期: ${session.date}`,
      `運動類型: ${activityMap[session.activityType] ?? session.activityType}`,
      `時間: ${session.durationMinutes ?? '?'} 分鐘`,
      `強度: ${intensityMap[session.intensity ?? ''] ?? session.intensity ?? '未記錄'}`,
      session.distanceKm ? `距離: ${session.distanceKm} km` : null,
      session.notes ? `備註: ${session.notes}` : null,
    ].filter(Boolean).join('\n');

    const exerciseLines = (session.exercises ?? []).map((ex) => {
      const parts = [`• ${ex.name} (${ex.type})`];
      if (ex.sets && ex.reps) parts.push(`${ex.sets} × ${ex.reps} reps`);
      if (ex.weightKg) parts.push(`@ ${ex.weightKg}kg`);
      if (ex.durationMin) parts.push(`${ex.durationMin} min`);
      return parts.join(' ');
    });

    const prompt = `你係一位香港健身教練。請用廣東話分析以下運動訓練，提供簡短、實用嘅意見。

訓練資料:
${sessionSummary}
${exerciseLines.length > 0 ? '\n動作:\n' + exerciseLines.join('\n') : ''}

請提供以下內容（用廣東話，保持簡潔）：
1. 整體表現評估（1-2句）
2. 重點動作觀察（如有具體動作數據，逐一點評；否則根據整體訓練評估）
3. 下次訓練建議（1-2點）

格式要求：
- 直接回答，唔好打「好嘅，我分析緊...」等開場白
- 每個部分用換行分隔
- 語氣專業但友善
- 總長度控制在150字以內`;

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const analysis = result.response.text().trim();

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=exercise-analyze`);

    res.json({ success: true, analysis });
  } catch (err) {
    console.error('[POST /exercise/:id/analyze]', err);
    res.status(500).json({ success: false, message: 'Analysis failed' });
  }
});

// ─── POST /exercise/:id/suggest — next-session training suggestions ──────────

router.post('/:id/suggest', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { id } = req.params;
    const sessionId = Array.isArray(id) ? id[0] : id;
    if (!Types.ObjectId.isValid(sessionId)) {
      res.status(400).json({ success: false, message: 'Invalid session ID' });
      return;
    }

    const session = await ExerciseSession.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }

    const recentSessions = await ExerciseSession.find({ userId })
      .sort({ date: -1 })
      .limit(5)
      .lean();

    const intensityMap: Record<string, string> = { easy: '輕鬆', moderate: '中等', hard: '高強度' };
    const activityMap: Record<string, string> = {
      gym: '健身室', running: '跑步', swimming: '游泳', basketball: '籃球',
      badminton: '羽毛球', cycling: '單車', yoga: '瑜伽', hiking: '行山', other: '其他',
    };

    const sessionSummary = [
      `今日訓練: ${activityMap[session.activityType] ?? session.activityType}`,
      `時間: ${session.durationMinutes ?? '?'} 分鐘`,
      `強度: ${intensityMap[session.intensity ?? ''] ?? session.intensity ?? '未記錄'}`,
      session.distanceKm ? `距離: ${session.distanceKm} km` : null,
    ].filter(Boolean).join(', ');

    const exerciseLines = (session.exercises ?? []).map((ex) => {
      const parts = [`• ${ex.name}`];
      if (ex.sets && ex.reps) parts.push(`${ex.sets}×${ex.reps}`);
      if (ex.weightKg) parts.push(`@ ${ex.weightKg}kg`);
      return parts.join(' ');
    });

    const recentLine = recentSessions.slice(1, 4).map(s =>
      `${activityMap[s.activityType] ?? s.activityType} (${s.durationMinutes ?? '?'}min, ${intensityMap[s.intensity ?? ''] ?? s.intensity ?? '?'})`
    ).join('; ');

    const prompt = `你係一位香港健身教練。請用廣東話根據以下訓練資料，建議用戶聽日或下次訓練嘅計劃。

今日訓練: ${sessionSummary}
${exerciseLines.length > 0 ? '今日動作:\n' + exerciseLines.join('\n') : ''}
最近記錄: ${recentLine || '暫無'}

請提供以下內容（廣東話，簡潔實用）：
1. 建議明日/下次訓練類型同強度（1句）
2. 具體建議動作或活動（2-3點）
3. 恢復或注意事項（1句）

格式要求：
- 直接回答，唔好打開場白
- 語氣專業但友善
- 總長度控制在150字以內`;

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const suggestion = result.response.text().trim();

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=exercise-suggest`);

    res.json({ success: true, suggestion });
  } catch (err) {
    console.error('[POST /exercise/:id/suggest]', err);
    res.status(500).json({ success: false, message: 'Suggestion failed' });
  }
});

// ─── POST /exercise/:id/progress — recent progress summary ───────────────────

router.post('/:id/progress', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { id } = req.params;
    const sessionId = Array.isArray(id) ? id[0] : id;
    if (!Types.ObjectId.isValid(sessionId)) {
      res.status(400).json({ success: false, message: 'Invalid session ID' });
      return;
    }

    const session = await ExerciseSession.findOne({ _id: sessionId, userId }).lean();
    if (!session) {
      res.status(404).json({ success: false, message: 'Session not found' });
      return;
    }

    const recentSessions = await ExerciseSession.find({ userId })
      .sort({ date: -1 })
      .limit(10)
      .lean();

    const activityMap: Record<string, string> = {
      gym: '健身室', running: '跑步', swimming: '游泳', basketball: '籃球',
      badminton: '羽毛球', cycling: '單車', yoga: '瑜伽', hiking: '行山', other: '其他',
    };
    const intensityMap: Record<string, string> = { easy: '輕鬆', moderate: '中等', hard: '高強度' };

    const sessionLines = recentSessions.map((s, i) => {
      const parts = [`${i + 1}. ${s.date} — ${activityMap[s.activityType] ?? s.activityType}`];
      parts.push(`${s.durationMinutes ?? '?'}min`);
      parts.push(intensityMap[s.intensity ?? ''] ?? (s.intensity ?? '?'));
      if (s.distanceKm) parts.push(`${s.distanceKm}km`);
      const maxWeight = (s.exercises ?? []).reduce((max, ex) => Math.max(max, ex.weightKg ?? 0), 0);
      if (maxWeight > 0) parts.push(`最高重量: ${maxWeight}kg`);
      return parts.join(', ');
    });

    const prompt = `你係一位香港健身教練。請用廣東話根據以下近期訓練記錄，分析用戶嘅進度同趨勢。

近期訓練記錄（最新優先）:
${sessionLines.join('\n')}

請提供以下內容（廣東話，簡潔實用）：
1. 整體訓練規律評估（1-2句）
2. 明顯進步或需關注嘅地方（1-2點）
3. 下階段建議方向（1句）

格式要求：
- 直接回答，唔好打開場白
- 語氣專業但友善
- 總長度控制在150字以內`;

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const progress = result.response.text().trim();

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=exercise-progress`);

    res.json({ success: true, progress });
  } catch (err) {
    console.error('[POST /exercise/:id/progress]', err);
    res.status(500).json({ success: false, message: 'Progress summary failed' });
  }
});

export default router;
