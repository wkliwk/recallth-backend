import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { processChat, checkRateLimit } from '../services/chatService';
import { Conversation } from '../models/Conversation';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { ExerciseSession } from '../models/ExerciseSession';
import { MODELS } from '../config/models';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

const chatRouter = Router();

// All routes require auth
chatRouter.use(authenticate);

// POST /chat — send message, get AI response
chatRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const { message, conversationId, language, image, imageMimeType, sessionTitle } = req.body as {
    message?: string;
    conversationId?: string;
    language?: string;
    image?: string;        // base64-encoded image data
    imageMimeType?: string; // e.g. 'image/jpeg', 'image/png'
    sessionTitle?: string; // optional human-readable title for auto-sessions (e.g. Stack Builder)
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ success: false, error: 'message is required', data: null });
    return;
  }

  if (message.trim().length > 4000) {
    res.status(400).json({ success: false, error: 'message too long (max 4000 characters)', data: null });
    return;
  }

  if (conversationId && !Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, error: 'invalid conversationId', data: null });
    return;
  }

  // Rate limiting
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.allowed) {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Maximum 30 messages per hour.',
      data: {
        resetAt: new Date(rateCheck.resetAt).toISOString(),
        remaining: 0,
      },
    });
    return;
  }

  const validLanguages = ['en', 'zh-HK', 'zh-TW'];
  const languageOverride = language && validLanguages.includes(language) ? language as 'en' | 'zh-HK' | 'zh-TW' : undefined;

  // Validate image if provided
  const validImageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const hasImage = image && imageMimeType && validImageTypes.includes(imageMimeType);

  const cleanSessionTitle = sessionTitle && typeof sessionTitle === 'string'
    ? sessionTitle.slice(0, 80).trim()
    : undefined;

  const result = await processChat(
    userId,
    message.trim(),
    conversationId,
    languageOverride,
    hasImage ? image : undefined,
    hasImage ? imageMimeType : undefined,
    cleanSessionTitle
  );

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversationId: result.conversationId,
      message: result.message,
      extractedData: result.extractedData,
      detectedLanguage: result.detectedLanguage,
      suggestions: result.suggestions,
      actions: result.actions,
    },
  });
});

// GET /chat/history — list conversations (paginated, 20/page)
chatRouter.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const limit = 20;
  const skip = (page - 1) * limit;

  const conversations = await Conversation.aggregate([
    { $match: { userId: new Types.ObjectId(userId), 'messages.0': { $exists: true } } },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        title: 1,
        summary: 1,
        createdAt: 1,
        messageCount: { $size: '$messages' },
      },
    },
  ]);

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversations,
      page,
      limit,
    },
  });
});

// GET /chat/:conversationId — get full conversation
chatRouter.get('/:conversationId', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const conversationId = String(req.params.conversationId);

  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, error: 'invalid conversationId', data: null });
    return;
  }

  const conversation = await Conversation.findOne({
    _id: new Types.ObjectId(conversationId),
    userId: new Types.ObjectId(userId),
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'Conversation not found', data: null });
    return;
  }

  res.status(200).json({
    success: true,
    error: null,
    data: conversation,
  });
});

// DELETE /chat/:conversationId — delete a conversation
chatRouter.delete('/:conversationId', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const conversationId = String(req.params.conversationId);

  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, error: 'invalid conversationId', data: null });
    return;
  }

  const result = await Conversation.deleteOne({
    _id: new Types.ObjectId(conversationId),
    userId: new Types.ObjectId(userId),
  });

  if (result.deletedCount === 0) {
    res.status(404).json({ success: false, error: 'Conversation not found', data: null });
    return;
  }

  res.status(200).json({ success: true, error: null, data: null });
});

// POST /chat/apply-action — apply a user-approved action from chat
chatRouter.post('/apply-action', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const userObjectId = new Types.ObjectId(userId);
  const { type, data, conversationId, messageIndex, actionIndex } = req.body as {
    type?: string;
    data?: Record<string, unknown>;
    conversationId?: string;
    messageIndex?: number;
    actionIndex?: number;
  };

  if (!type || !data) {
    res.status(400).json({ success: false, error: 'type and data are required', data: null });
    return;
  }

  try {
    if (type === 'save_profile') {
      // Build $set from dot-notation keys, sanitizing numeric fields
      const numericFields = new Set(['body.height', 'body.weight', 'body.age']);
      const profileSet: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value !== null && value !== undefined) {
          if (numericFields.has(key) && typeof value === 'string') {
            const num = parseFloat(value.replace(/[^0-9.]/g, ''));
            if (!isNaN(num)) profileSet[key] = num;
          } else {
            profileSet[key] = value;
          }
        }
      }
      if (Object.keys(profileSet).length > 0) {
        await HealthProfile.findOneAndUpdate(
          { userId: userObjectId },
          { $set: profileSet },
          { upsert: true, new: true }
        );
      }
      // Mark action as applied in conversation
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'profile', fields: Object.keys(profileSet) } });
    } else if (type === 'add_cabinet') {
      const name = data.name as string;
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required for add_cabinet', data: null });
        return;
      }
      // Check if already exists
      const existing = await CabinetItem.findOne({
        userId: userObjectId,
        name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        active: true,
      });
      if (existing) {
        // Still mark as applied
        if (conversationId && messageIndex != null && actionIndex != null) {
          await Conversation.updateOne(
            { _id: new Types.ObjectId(conversationId), userId: userObjectId },
            { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
          );
        }
        res.json({ success: true, error: null, data: { applied: 'cabinet', action: 'already_exists', itemId: String(existing._id) } });
        return;
      }
      const item = await CabinetItem.create({
        userId: userObjectId,
        name,
        type: (data.type as string) || 'supplement',
        dosage: (data.dosage as string) || undefined,
        frequency: (data.frequency as string) || undefined,
        timing: (data.timing as string) || undefined,
        brand: (data.brand as string) || undefined,
        source: 'ai_extracted',
        active: true,
      });
      // Mark action as applied in conversation
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'cabinet', action: 'created', itemId: String(item._id) } });
    } else if (type === 'add_exercise_set') {
      const sessionId = data.sessionId as string;
      const exerciseName = data.exerciseName as string;
      const sets = Number(data.sets);
      const reps = Number(data.reps);
      const weightKg = data.weightKg != null ? Number(data.weightKg) : undefined;

      if (!sessionId || !exerciseName || isNaN(sets) || isNaN(reps)) {
        res.status(400).json({ success: false, error: 'sessionId, exerciseName, sets, and reps are required', data: null });
        return;
      }
      if (!Types.ObjectId.isValid(sessionId)) {
        res.status(400).json({ success: false, error: 'Invalid sessionId', data: null });
        return;
      }

      const session = await ExerciseSession.findById(sessionId);
      if (!session) {
        res.status(404).json({ success: false, error: 'Exercise session not found', data: null });
        return;
      }
      if (session.userId.toString() !== userId) {
        res.status(403).json({ success: false, error: 'Forbidden', data: null });
        return;
      }

      const newEntry: { name: string; sets: number; reps: number; weightKg?: number } = {
        name: exerciseName.trim(),
        sets,
        reps,
        ...(weightKg != null && !isNaN(weightKg) ? { weightKg } : {}),
      };
      const updatedExercises = [...(session.exercises ?? []), newEntry];
      const updated = await ExerciseSession.findByIdAndUpdate(
        sessionId,
        { $set: { exercises: updatedExercises } },
        { new: true }
      );

      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'exercise_set', sessionId, exerciseName, sets, reps, weightKg, updated: updated?.exercises } });
    } else if (type === 'plan_exercise') {
      const activityType = data.activityType as string;
      const date = data.date as string;
      if (!activityType || !date) {
        res.status(400).json({ success: false, error: 'activityType and date are required for plan_exercise', data: null });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD', data: null });
        return;
      }
      const validExTypes = ['strength', 'bodyweight', 'timed', 'cardio', 'session'];
      const exercises = Array.isArray(data.exercises)
        ? (data.exercises as Record<string, unknown>[])
            .filter((ex) => typeof ex.name === 'string' && ex.name.trim().length > 0)
            .map((ex) => {
              const exType = validExTypes.includes(ex.type as string) ? (ex.type as string) : 'strength';
              const exOut: Record<string, unknown> = { name: (ex.name as string).trim(), type: exType };
              if (typeof ex.sets === 'number' && ex.sets > 0) exOut.sets = ex.sets;
              if (typeof ex.reps === 'number' && ex.reps > 0) exOut.reps = ex.reps;
              if (typeof ex.weightKg === 'number' && ex.weightKg > 0) exOut.weightKg = ex.weightKg;
              if (typeof ex.durationMin === 'number' && ex.durationMin > 0) exOut.durationMin = ex.durationMin;
              if (typeof ex.distanceKm === 'number' && ex.distanceKm > 0) exOut.distanceKm = ex.distanceKm;
              return exOut;
            })
        : [];
      const session = await ExerciseSession.create({
        userId: userObjectId,
        status: 'planned',
        activityType: activityType.trim(),
        date,
        durationMinutes: typeof data.durationMinutes === 'number' ? data.durationMinutes : 0,
        intensity: typeof data.intensity === 'string' ? data.intensity : 'moderate',
        notes: typeof data.notes === 'string' ? data.notes.trim() : undefined,
        ...(exercises.length > 0 ? { exercises } : {}),
      });
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'plan_exercise', sessionId: String(session._id) } });
    } else if (type === 'save_injury') {
      const name = data.name as string;
      if (!name) {
        res.status(400).json({ success: false, error: 'name is required for save_injury', data: null });
        return;
      }
      const injury = {
        name: name.trim(),
        location: typeof data.location === 'string' ? data.location.trim() : undefined,
        onsetDate: typeof data.onsetDate === 'string' ? data.onsetDate : undefined,
        status: (data.status === 'active' || data.status === 'recovering') ? data.status : 'active' as const,
        notes: typeof data.notes === 'string' ? data.notes.trim() : undefined,
        lastCheckedAt: new Date(),
      };
      await HealthProfile.findOneAndUpdate(
        { userId: userObjectId },
        { $push: { injuries: injury } },
        { upsert: true, new: true }
      );
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'injury', action: 'created', name: injury.name } });
    } else if (type === 'update_injury') {
      const name = data.name as string;
      const status = data.status as string;
      if (!name || !status) {
        res.status(400).json({ success: false, error: 'name and status are required for update_injury', data: null });
        return;
      }
      const validStatuses = ['active', 'recovering', 'resolved'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({ success: false, error: 'status must be active, recovering, or resolved', data: null });
        return;
      }
      // Find profile and update matching injury by name (case-insensitive)
      const profile = await HealthProfile.findOne({ userId: userObjectId });
      if (!profile) {
        res.status(404).json({ success: false, error: 'Health profile not found', data: null });
        return;
      }
      const injuryIndex = profile.injuries.findIndex(
        (inj) => inj.name.toLowerCase() === name.toLowerCase().trim()
      );
      if (injuryIndex === -1) {
        res.status(404).json({ success: false, error: `Injury "${name}" not found in profile`, data: null });
        return;
      }
      const updateFields: Record<string, unknown> = {
        [`injuries.${injuryIndex}.status`]: status,
        [`injuries.${injuryIndex}.lastCheckedAt`]: new Date(),
      };
      if (typeof data.notes === 'string') {
        updateFields[`injuries.${injuryIndex}.notes`] = data.notes.trim();
      }
      await HealthProfile.updateOne({ userId: userObjectId }, { $set: updateFields });
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'injury', action: 'updated', name, status } });
    } else if (type === 'save_training_goal') {
      const description = data.description as string;
      if (!description) {
        res.status(400).json({ success: false, error: 'description is required for save_training_goal', data: null });
        return;
      }
      const goal: Record<string, unknown> = {
        description: description.trim(),
        createdAt: new Date(),
      };
      if (typeof data.targetMetric === 'string') goal.targetMetric = data.targetMetric.trim();
      if (typeof data.targetValue === 'number') goal.targetValue = data.targetValue;
      if (typeof data.targetUnit === 'string') goal.targetUnit = data.targetUnit.trim();
      await HealthProfile.findOneAndUpdate(
        { userId: userObjectId },
        { $push: { trainingGoals: goal } },
        { upsert: true, new: true }
      );
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'training_goal', action: 'created', description: goal.description } });
    } else if (type === 'save_sport') {
      const sport = data.sport as string;
      if (!sport) {
        res.status(400).json({ success: false, error: 'sport is required for save_sport', data: null });
        return;
      }
      const sportEntry: Record<string, unknown> = {
        sport: sport.trim(),
      };
      if (typeof data.experience === 'string') sportEntry.experience = data.experience.trim();
      const validSportStatuses = ['active', 'learning', 'past'];
      sportEntry.status = typeof data.status === 'string' && validSportStatuses.includes(data.status) ? data.status : 'active';
      await HealthProfile.findOneAndUpdate(
        { userId: userObjectId },
        { $push: { sportsBackground: sportEntry } },
        { upsert: true, new: true }
      );
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'sport', action: 'created', sport: sportEntry.sport } });
    } else if (type === 'update_focus_areas') {
      const focusAreas = data.focusAreas;
      if (!Array.isArray(focusAreas)) {
        res.status(400).json({ success: false, error: 'focusAreas array is required for update_focus_areas', data: null });
        return;
      }
      const sanitized = focusAreas
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      await HealthProfile.findOneAndUpdate(
        { userId: userObjectId },
        { $set: { focusAreas: sanitized } },
        { upsert: true, new: true }
      );
      if (conversationId && messageIndex != null && actionIndex != null) {
        await Conversation.updateOne(
          { _id: new Types.ObjectId(conversationId), userId: userObjectId },
          { $set: { [`messages.${messageIndex}.actions.${actionIndex}.applied`]: true } }
        );
      }
      res.json({ success: true, error: null, data: { applied: 'focus_areas', action: 'updated', focusAreas: sanitized } });
    } else {
      res.status(400).json({ success: false, error: `Unknown action type: ${type}`, data: null });
    }
  } catch (err) {
    console.error('[POST /chat/apply-action]', err);
    res.status(500).json({ success: false, error: 'Failed to apply action', data: null });
  }
});

// ─── GET /chat/meal-suggestions ──────────────────────────────────────────────

interface MealSuggestion {
  type: 'breakfast' | 'lunch' | 'dinner';
  name: string;
  description: string;
  whyThisMeal: string;
}

chatRouter.get('/meal-suggestions', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const userObjectId = new Types.ObjectId(userId);

  try {
    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId: userObjectId }).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
    ]);

    const profileSummary = profile
      ? {
          body: profile.body,
          diet: profile.diet,
          exercise: profile.exercise,
          goals: profile.goals,
        }
      : null;

    const cabinetSummary = cabinetItems.map((i) => ({
      name: i.name,
      type: i.type,
      dosage: i.dosage,
    }));

    const prompt = `You are a registered nutritionist. Based on the user's health profile and supplement cabinet below, suggest 3 meals for today (breakfast, lunch, dinner).

USER PROFILE:
${JSON.stringify(profileSummary, null, 2)}

SUPPLEMENT CABINET:
${JSON.stringify(cabinetSummary, null, 2)}

Instructions:
- Respect all dietary restrictions, allergies, and diet type from the profile
- Consider the supplement stack — suggest foods that complement (e.g. if taking creatine, suggest adequate protein)
- Align with the user's health goals
- Keep suggestions practical and achievable
- If profile is empty or minimal, suggest balanced nutritious meals

Return ONLY valid JSON in this exact format (no markdown, no extra text):
[
  { "type": "breakfast", "name": "...", "description": "...", "whyThisMeal": "..." },
  { "type": "lunch", "name": "...", "description": "...", "whyThisMeal": "..." },
  { "type": "dinner", "name": "...", "description": "...", "whyThisMeal": "..." }
]`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const meals = JSON.parse(cleaned) as MealSuggestion[];

    res.status(200).json({ success: true, error: null, data: { meals } });
  } catch (err) {
    console.error('[GET /chat/meal-suggestions]', err);
    res.status(500).json({ success: false, error: 'Failed to generate meal suggestions', data: null });
  }
});

// ─── GET /chat/gym-nutrition ─────────────────────────────────────────────────

interface GymNutritionResponse {
  timing: string;
  foods: Array<{ name: string; amount: string; reason: string }>;
  supplements: Array<{ name: string; timing: string; reason: string }>;
  summary: string;
}

chatRouter.get('/gym-nutrition', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const userObjectId = new Types.ObjectId(userId);

  try {
    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId: userObjectId }).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
    ]);

    const profileSummary = profile
      ? {
          body: profile.body,
          exercise: profile.exercise,
          goals: profile.goals,
        }
      : null;

    const cabinetSummary = cabinetItems.map((i) => ({
      name: i.name,
      type: i.type,
      dosage: i.dosage,
      timing: i.timing,
    }));

    const prompt = `You are a sports nutritionist. Based on the user's profile and supplement cabinet, provide post-workout nutrition advice.

USER PROFILE:
${JSON.stringify(profileSummary, null, 2)}

SUPPLEMENT CABINET:
${JSON.stringify(cabinetSummary, null, 2)}

Instructions:
- Recommend when to eat post-workout (e.g. within 30 minutes, within 2 hours)
- Suggest 3-5 specific foods with amounts and reasons
- Reference their actual supplement stack — which ones to take post-workout and why
- Align with their fitness goals (muscle gain, fat loss, endurance, etc.)
- If exercise profile is empty, give general post-workout advice

Return ONLY valid JSON (no markdown):
{
  "timing": "...",
  "foods": [{ "name": "...", "amount": "...", "reason": "..." }],
  "supplements": [{ "name": "...", "timing": "...", "reason": "..." }],
  "summary": "..."
}`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const gymNutrition = JSON.parse(cleaned) as GymNutritionResponse;

    res.status(200).json({ success: true, error: null, data: gymNutrition });
  } catch (err) {
    console.error('[GET /chat/gym-nutrition]', err);
    res.status(500).json({ success: false, error: 'Failed to generate gym nutrition advice', data: null });
  }
});

export default chatRouter;
