import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { MealEntry, UserNutritionCategory, NutritionCategory } from '../models/Nutrition';
import { CabinetItem } from '../models/CabinetItem';
import { MODELS } from '../config/models';
import { CATEGORY_TARGETS } from '../utils/nutritionTargets';

const router = Router();

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

// ─── POST /nutrition/parse — AI food parsing ──────────────────────────────

router.post('/parse', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { text, category } = req.body as { text?: unknown; category?: unknown };

    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'text is required' });
      return;
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a nutrition expert. Parse the following food description and return structured nutrition data.
The input may be in English, Cantonese, or Traditional Chinese (Hong Kong context). Recognise HK local food names.

Food description: "${text.trim()}"
${typeof category === 'string' && category.trim().length > 0 ? `Nutrition category context: ${category.trim()}` : ''}

Return a JSON array of food items. Each item must have:
- name: food name (keep original language if Chinese/Cantonese)
- quantity: numeric quantity (number)
- unit: serving unit (e.g. 碟, 杯, 碗, 份, g, ml, piece)
- nutrients: object with any relevant values from: calories (kcal), protein (g), carbs (g), fat (g), sugar (g), fiber (g), sodium (mg), potassium (mg), phosphorus (mg), folate (µg), iron (mg), calcium (mg)

Use realistic estimates for HK portion sizes. Return ONLY a valid JSON array, no markdown, no explanation.
Example: [{"name":"叉燒飯","quantity":1,"unit":"碟","nutrients":{"calories":650,"protein":28,"carbs":80,"fat":18}}]`;

    const result = await model.generateContent(prompt);
    const text2 = result.response.text().trim();

    // Extract JSON array from response (same pattern as cabinet ai-lookup)
    const jsonMatch = text2.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    const foods = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(foods)) {
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    res.json({ success: true, data: { foods }, error: null });
  } catch (err) {
    console.error('[POST /nutrition/parse]', err);
    res.status(500).json({ success: false, data: null, error: 'AI food parsing failed' });
  }
});

// ─── GET /nutrition/summary — daily nutrient totals ───────────────────────
// Must be defined before GET /nutrition/:id to avoid route conflict

router.get('/summary', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { date } = req.query as { date?: string };
    const targetDate = typeof date === 'string' && DATE_REGEX.test(date) ? date : todayString();

    const entries = await MealEntry.find({ userId, date: targetDate }).lean();

    // Aggregate nutrients across all meal entries for the day
    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const food of entry.foods) {
        const nutrientsMap = food.nutrients as unknown as Map<string, number> | Record<string, number>;
        const pairs: [string, number][] =
          nutrientsMap instanceof Map
            ? Array.from(nutrientsMap.entries())
            : Object.entries(nutrientsMap as Record<string, number>);
        for (const [key, value] of pairs) {
          totals[key] = (totals[key] ?? 0) + value;
        }
      }
    }

    // Load category for this user (default: gym)
    const categoryDoc = await UserNutritionCategory.findOne({ userId }).lean();
    const category: NutritionCategory = categoryDoc?.category ?? 'gym';
    const targets = CATEGORY_TARGETS[category];

    // Build response: only nutrients that have a target defined
    const nutrients: Record<
      string,
      { actual: number; target: number; unit: string; type: 'min' | 'max' }
    > = {};

    for (const t of targets) {
      nutrients[t.nutrient] = {
        actual: Math.round((totals[t.nutrient] ?? 0) * 10) / 10,
        target: t.dailyTarget,
        unit: t.unit,
        type: t.type,
      };
    }

    res.json({ success: true, data: { date: targetDate, category, nutrients }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/summary]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get nutrition summary' });
  }
});

// ─── GET /nutrition/category — get user's nutrition category ──────────────

router.get('/category', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const doc = await UserNutritionCategory.findOne({ userId }).lean();
    const category: NutritionCategory = doc?.category ?? 'gym';
    res.json({ success: true, data: { category }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/category]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get nutrition category' });
  }
});

// ─── PUT /nutrition/category — set user's nutrition category ─────────────

router.put('/category', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { category } = req.body as { category?: unknown };

    const validCategories: NutritionCategory[] = [
      'gym',
      'weight-loss',
      'diabetes',
      'kidney',
      'pregnancy',
      'custom',
    ];

    if (typeof category !== 'string' || !validCategories.includes(category as NutritionCategory)) {
      res.status(400).json({
        success: false,
        data: null,
        error: `category must be one of: ${validCategories.join(', ')}`,
      });
      return;
    }

    const doc = await UserNutritionCategory.findOneAndUpdate(
      { userId },
      { userId, category: category as NutritionCategory, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: { category: doc.category }, error: null });
  } catch (err) {
    console.error('[PUT /nutrition/category]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to update nutrition category' });
  }
});

// ─── Supplement matching heuristic ───────────────────────────────────────
// Maps nutrient names to keyword sets that identify matching supplements.

const NUTRIENT_KEYWORDS: Record<string, string[]> = {
  protein: ['protein', 'whey', 'casein'],
  vitamin_d: ['vitamin d', 'vit d', 'd3'],
  fat: ['omega', 'fish oil', 'epa', 'dha'],
  iron: ['iron', 'ferrous'],
  calcium: ['calcium'],
  magnesium: ['magnesium', 'mag'],
  zinc: ['zinc'],
  folate: ['folate', 'folic', 'b9'],
  fiber: ['fiber', 'fibre', 'psyllium'],
};

function supplementFillsGap(supplementName: string, nutrient: string): boolean {
  const keywords = NUTRIENT_KEYWORDS[nutrient];
  if (!keywords) return false;
  const lowerName = supplementName.toLowerCase();
  return keywords.some((kw) => lowerName.includes(kw));
}

// Cantonese nutrient display names
const NUTRIENT_DISPLAY: Record<string, string> = {
  protein: '蛋白質',
  calories: '卡路里',
  carbs: '碳水化合物',
  fat: '脂肪',
  sugar: '糖分',
  fiber: '膳食纖維',
  sodium: '鈉',
  potassium: '鉀',
  phosphorus: '磷',
  folate: '葉酸',
  iron: '鐵質',
  calcium: '鈣質',
  magnesium: '鎂',
  zinc: '鋅',
  vitamin_d: '維他命D',
};

function nutrientDisplayName(nutrient: string): string {
  return NUTRIENT_DISPLAY[nutrient] ?? nutrient;
}

// ─── GET /nutrition/recommendations — supplement gap recommendations ──────

router.get('/recommendations', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { date } = req.query as { date?: string };
    const targetDate = typeof date === 'string' && DATE_REGEX.test(date) ? date : todayString();

    // Step 1: Aggregate daily nutrients from MealEntry
    const entries = await MealEntry.find({ userId, date: targetDate }).lean();

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const food of entry.foods) {
        const nutrientsMap = food.nutrients as unknown as Map<string, number> | Record<string, number>;
        const pairs: [string, number][] =
          nutrientsMap instanceof Map
            ? Array.from(nutrientsMap.entries())
            : Object.entries(nutrientsMap as Record<string, number>);
        for (const [key, value] of pairs) {
          totals[key] = (totals[key] ?? 0) + value;
        }
      }
    }

    // Step 2: Load user nutrition category (default: gym)
    const categoryDoc = await UserNutritionCategory.findOne({ userId }).lean();
    const category: NutritionCategory = categoryDoc?.category ?? 'gym';

    // Step 3: Load targets and identify gaps
    const targets = CATEGORY_TARGETS[category];

    interface NutrientGap {
      nutrient: string;
      target: number;
      actual: number;
      gap: number;
      unit: string;
      type: 'min' | 'max';
    }

    const gaps: NutrientGap[] = [];

    for (const t of targets) {
      const actual = Math.round((totals[t.nutrient] ?? 0) * 10) / 10;
      if (t.type === 'min' && actual < t.dailyTarget) {
        gaps.push({
          nutrient: t.nutrient,
          target: t.dailyTarget,
          actual,
          gap: Math.round((t.dailyTarget - actual) * 10) / 10,
          unit: t.unit,
          type: 'min',
        });
      } else if (t.type === 'max' && actual > t.dailyTarget) {
        gaps.push({
          nutrient: t.nutrient,
          target: t.dailyTarget,
          actual,
          gap: Math.round((actual - t.dailyTarget) * 10) / 10,
          unit: t.unit,
          type: 'max',
        });
      }
    }

    // Step 4: Fetch user's supplement cabinet (active supplements only)
    const cabinet = await CabinetItem.find({
      userId,
      active: true,
      type: { $in: ['supplement', 'vitamin'] },
    }).lean();

    // Step 5: Match supplements to gaps and build recommendations
    interface Recommendation {
      supplement: { id: string; name: string; dosage: string };
      reason: string;
      fillsGap: string;
    }

    const recommendations: Recommendation[] = [];
    const filledGaps = new Set<string>();

    for (const gap of gaps) {
      for (const item of cabinet) {
        if (supplementFillsGap(item.name, gap.nutrient)) {
          const displayName = nutrientDisplayName(gap.nutrient);
          const reason =
            gap.type === 'min'
              ? `你今日${displayName}仲差 ${gap.gap}${gap.unit}，${item.name} 可以幫你補返`
              : `你今日${displayName}已超標 ${gap.gap}${gap.unit}，留意${item.name}唔好再加`;

          recommendations.push({
            supplement: {
              id: (item._id as Types.ObjectId).toString(),
              name: item.name,
              dosage: item.dosage ?? '',
            },
            reason,
            fillsGap: gap.nutrient,
          });

          filledGaps.add(gap.nutrient);
          break; // one supplement per gap
        }
      }
    }

    const allGapsFilled = gaps.length > 0 && gaps.every((g) => filledGaps.has(g.nutrient));

    res.json({
      success: true,
      data: {
        date: targetDate,
        gaps,
        recommendations,
        allGapsFilled,
      },
      error: null,
    });
  } catch (err) {
    console.error('[GET /nutrition/recommendations]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get recommendations' });
  }
});

// ─── GET /nutrition/days — dates with entries for a month (#133) ─────────

router.get('/days', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { year, month } = req.query as { year?: string; month?: string };

    if (
      typeof year !== 'string' || !/^\d{4}$/.test(year) ||
      typeof month !== 'string' || !/^\d{2}$/.test(month)
    ) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'year (YYYY) and month (MM) are required',
      });
      return;
    }

    const prefix = `${year}-${month}`;
    const days = await MealEntry.distinct('date', {
      userId,
      date: { $regex: `^${prefix}` },
    });

    res.json({ success: true, data: (days as string[]).sort(), error: null });
  } catch (err) {
    console.error('[GET /nutrition/days]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get days with entries' });
  }
});

// ─── GET /nutrition — list meal entries for a date ────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { date } = req.query as { date?: string };
    const targetDate = typeof date === 'string' && DATE_REGEX.test(date) ? date : todayString();

    const entries = await MealEntry.find({ userId, date: targetDate }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: entries, error: null });
  } catch (err) {
    console.error('[GET /nutrition]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get meal entries' });
  }
});

// ─── POST /nutrition — create meal entry ─────────────────────────────────

router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { date, mealType, foods, rawText } = req.body as {
      date?: unknown;
      mealType?: unknown;
      foods?: unknown;
      rawText?: unknown;
    };

    if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
      res.status(400).json({ success: false, data: null, error: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
    if (typeof mealType !== 'string' || !validMealTypes.includes(mealType)) {
      res.status(400).json({
        success: false,
        data: null,
        error: `mealType must be one of: ${validMealTypes.join(', ')}`,
      });
      return;
    }

    if (!Array.isArray(foods)) {
      res.status(400).json({ success: false, data: null, error: 'foods must be an array' });
      return;
    }

    const entryData: Record<string, unknown> = {
      userId,
      date,
      mealType,
      foods,
    };

    if (typeof rawText === 'string' && rawText.trim().length > 0) {
      entryData.rawText = rawText.trim();
    }

    const entry = await MealEntry.create(entryData);
    res.status(201).json({ success: true, data: entry, error: null });
  } catch (err) {
    console.error('[POST /nutrition]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to create meal entry' });
  }
});

// ─── PUT /nutrition/:id — update meal entry ───────────────────────────────

router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, data: null, error: 'Invalid entry id' });
      return;
    }

    const existing = await MealEntry.findById(id);
    if (!existing) {
      res.status(404).json({ success: false, data: null, error: 'Meal entry not found' });
      return;
    }

    if (existing.userId.toString() !== userId) {
      res.status(403).json({ success: false, data: null, error: 'Forbidden' });
      return;
    }

    const { date, mealType, foods, rawText } = req.body as {
      date?: unknown;
      mealType?: unknown;
      foods?: unknown;
      rawText?: unknown;
    };

    const updates: Record<string, unknown> = {};

    if (typeof date === 'string' && DATE_REGEX.test(date)) {
      updates.date = date;
    }

    const validMealTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
    if (typeof mealType === 'string' && validMealTypes.includes(mealType)) {
      updates.mealType = mealType;
    }

    if (Array.isArray(foods)) {
      updates.foods = foods;
    }

    if (typeof rawText === 'string') {
      updates.rawText = rawText.trim();
    }

    const updated = await MealEntry.findByIdAndUpdate(id, updates, { new: true });
    res.json({ success: true, data: updated, error: null });
  } catch (err) {
    console.error('[PUT /nutrition/:id]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to update meal entry' });
  }
});

// ─── DELETE /nutrition/:id — delete meal entry ────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, data: null, error: 'Invalid entry id' });
      return;
    }

    const existing = await MealEntry.findById(id);
    if (!existing) {
      res.status(404).json({ success: false, data: null, error: 'Meal entry not found' });
      return;
    }

    if (existing.userId.toString() !== userId) {
      res.status(403).json({ success: false, data: null, error: 'Forbidden' });
      return;
    }

    await MealEntry.findByIdAndDelete(id);
    res.json({ success: true, data: { success: true }, error: null });
  } catch (err) {
    console.error('[DELETE /nutrition/:id]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to delete meal entry' });
  }
});

export default router;
