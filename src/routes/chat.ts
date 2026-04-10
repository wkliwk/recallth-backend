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
  const { message, conversationId } = req.body as {
    message?: string;
    conversationId?: string;
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

  const result = await processChat(userId, message.trim(), conversationId);

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversationId: result.conversationId,
      message: result.message,
      extractedData: result.extractedData,
      detectedLanguage: result.detectedLanguage,
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

export default chatRouter;
