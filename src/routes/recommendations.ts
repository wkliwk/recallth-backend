import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { getCached, setCached } from '../models/AiCache';
import { MODELS } from '../config/models';

export interface Recommendation {
  name: string;
  type: 'supplement' | 'vitamin' | 'medication';
  dosage?: string;
  frequency?: string;
  benefit: string;
}

const router = Router();
router.use(authenticate);

const getGenAI = () => {
  const key = process.env.GOOGLE_GEMINI_API_KEY;
  if (!key) throw new Error('GOOGLE_GEMINI_API_KEY not set');
  return new GoogleGenerativeAI(key);
};

// GET /recommendations — returns 1-3 AI-generated supplement recommendations
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);
  const cacheKey = req.userId!;

  const cached = await getCached<Recommendation[]>('recommendations', cacheKey);
  if (cached) {
    res.json({ success: true, data: cached, error: null });
    return;
  }

  const [profile, cabinet] = await Promise.all([
    HealthProfile.findOne({ userId }).lean(),
    CabinetItem.find({ userId, active: true }).select('name type dosage').lean(),
  ]);

  const existing = cabinet.map((c) => c.name);
  const goals = profile?.goals ?? {};
  const body = profile?.body ?? {};
  const exercise = profile?.exercise ?? {};
  const diet = profile?.diet ?? {};

  const prompt = `You are a registered nutritionist. Based on this user's profile and their current supplement stack, suggest exactly 1 to 3 supplements they should consider adding. Do NOT suggest anything already in their stack.

CURRENT STACK: ${existing.length > 0 ? existing.join(', ') : 'none'}
PROFILE SUMMARY:
- Age: ${body.age ?? 'unknown'}, Sex: ${body.sex ?? 'unknown'}
- Goals: ${JSON.stringify(goals)}
- Exercise: ${JSON.stringify(exercise)}
- Diet: ${JSON.stringify(diet)}

Rules:
- Only suggest well-researched, evidence-backed supplements
- Each suggestion must have a clear, specific benefit tied to the user's profile/goals
- If the stack already covers all major bases, return an empty array
- Dosage and frequency must be realistic and safe defaults

Return ONLY valid JSON, no markdown:
[
  {
    "name": "string",
    "type": "supplement" | "vitamin" | "medication",
    "dosage": "string or null",
    "frequency": "string or null",
    "benefit": "one short sentence — specific to this user's goals"
  }
]`;

  let recommendations: Recommendation[] = [];
  try {
    const genai = getGenAI();
    const model = genai.getGenerativeModel({ model: MODELS.EXTRACTION });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/^```json\n?|^```\n?|\n?```$/g, '');
    const parsed = JSON.parse(text) as Recommendation[];
    recommendations = Array.isArray(parsed) ? parsed.slice(0, 3) : [];
  } catch (err) {
    console.error('[recommendations] AI error:', err);
  }

  await setCached('recommendations', cacheKey, recommendations);
  res.json({ success: true, data: recommendations, error: null });
});

// DELETE /recommendations/cache — bust the 24h cache so next GET regenerates
router.delete('/cache', async (req: AuthRequest, res: Response): Promise<void> => {
  const { deleteCached } = await import('../models/AiCache');
  await deleteCached('recommendations', req.userId!);
  res.json({ success: true, data: null, error: null });
});

export { router as recommendationsRouter };
