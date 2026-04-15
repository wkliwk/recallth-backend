import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { processChat, checkRateLimit } from '../services/chatService';
import { Conversation } from '../models/Conversation';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
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
  const { message, conversationId, language } = req.body as {
    message?: string;
    conversationId?: string;
    language?: string;
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
  const result = await processChat(userId, message.trim(), conversationId, languageOverride);

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversationId: result.conversationId,
      message: result.message,
      extractedData: result.extractedData,
      detectedLanguage: result.detectedLanguage,
      suggestions: result.suggestions,
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
    { $match: { userId: new Types.ObjectId(userId) } },
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
