import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { MealEntry, UserNutritionCategory, UserNutritionCustomConfig, NutritionCategory } from '../models/Nutrition';
import { CabinetItem } from '../models/CabinetItem';
import { UserFoodItem } from '../models/UserFoodItem';
import { MODELS } from '../config/models';
import { CATEGORY_TARGETS, computePersonalisedTargets, PersonalisedFormula } from '../utils/nutritionTargets';
import { HealthProfile, ActivityLevel } from '../models/HealthProfile';
import { buildAiUsage } from '../utils/aiUsage';

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

// ─── Valid nutrient keys for custom config ────────────────────────────────

const VALID_NUTRIENT_KEYS = [
  'calories',
  'protein',
  'carbs',
  'fat',
  'sugar',
  'fiber',
  'sodium',
  'folate',
  'iron',
] as const;

const DEFAULT_CUSTOM_NUTRIENTS = ['calories', 'protein', 'carbs', 'fat'];
const DEFAULT_CUSTOM_GOALS: Record<string, number> = {
  calories: 2000,
  protein: 150,
  carbs: 200,
  fat: 65,
};

// ─── POST /nutrition/parse — AI food parsing ──────────────────────────────

router.post('/parse', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { text, category } = req.body as { text?: unknown; category?: unknown };

    if (typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'text is required' });
      return;
    }

    // Build category context string — for custom, include the user's tracked nutrients
    let categoryContext = '';
    if (typeof category === 'string' && category.trim().length > 0) {
      if (category.trim() === 'custom') {
        const customConfigDoc = await UserNutritionCustomConfig.findOne({ userId }).lean();
        const customNutrients: string[] = customConfigDoc?.nutrients ?? DEFAULT_CUSTOM_NUTRIENTS;
        categoryContext = `custom (nutrients to track: ${customNutrients.join(', ')})`;
      } else {
        categoryContext = category.trim();
      }
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a nutrition expert for Hong Kong food. Parse the following food description and return structured nutrition data.
The input may be in English, Cantonese, or Traditional Chinese (Hong Kong context). Recognise HK local food names and chain restaurants.

Food description: "${text.trim()}"
${categoryContext.length > 0 ? `Nutrition category context: ${categoryContext}` : ''}

IMPORTANT — Set meal detection:
If the input is a set meal / combo (contains words like 餐, 套餐, set, combo, or references a known chain's meal deal), you MUST:
1. List ALL fixed components of the set as confirmed items in "foods"
2. If the set includes a DRINK CHOICE (飲品), list the common drink options for that chain/meal as "suggestions" — these are NOT confirmed, the user will pick one

Return a JSON object with two keys:
- "foods": array of confirmed food items (always present, may be empty)
- "suggestions": array of possible drink/add-on choices (present only when set meal has variable components, otherwise omit or use [])

Each item in both arrays must have:
- name: food name (keep original language)
- quantity: numeric quantity
- unit: serving unit (e.g. 杯, 份, g)
- nutrients: object with relevant values from: calories (kcal), protein (g), carbs (g), fat (g), sugar (g), fiber (g), sodium (mg)

Use realistic HK portion sizes and chain-specific nutrition data where known.
Return ONLY valid JSON, no markdown, no explanation.

Example for a set meal with drink choice:
{"foods":[{"name":"麥當勞豬柳蛋漢堡","quantity":1,"unit":"份","nutrients":{"calories":430,"protein":19,"carbs":35,"fat":24}},{"name":"麥當勞薯餅","quantity":1,"unit":"份","nutrients":{"calories":140,"protein":1.5,"carbs":15,"fat":8}}],"suggestions":[{"name":"麥當勞咖啡","quantity":1,"unit":"杯","nutrients":{"calories":80,"protein":3,"carbs":10,"fat":3}},{"name":"麥當勞奶茶","quantity":1,"unit":"杯","nutrients":{"calories":90,"protein":3,"carbs":12,"fat":3}},{"name":"麥當勞熱朱古力","quantity":1,"unit":"杯","nutrients":{"calories":120,"protein":4,"carbs":18,"fat":4}}]}

Example for a non-set item:
{"foods":[{"name":"叉燒飯","quantity":1,"unit":"碟","nutrients":{"calories":650,"protein":28,"carbs":80,"fat":18}}],"suggestions":[]}`;

    const result = await model.generateContent(prompt);
    const text2 = result.response.text().trim();

    // Extract JSON object or array from response
    const jsonMatch = text2.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) {
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    let foods: unknown[];
    let suggestions: unknown[];

    if (Array.isArray(parsed)) {
      // Legacy array response — treat all as confirmed foods
      foods = parsed;
      suggestions = [];
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      foods = Array.isArray(obj.foods) ? obj.foods : [];
      suggestions = Array.isArray(obj.suggestions) ? obj.suggestions : [];
    } else {
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    const usage = result.response.usageMetadata;
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=nutrition-parse`);

    res.json({ success: true, data: { foods, suggestions }, aiUsage, error: null });
  } catch (err) {
    console.error('[POST /nutrition/parse]', err);
    res.status(500).json({ success: false, data: null, error: 'AI food parsing failed' });
  }
});

interface FoodProduct {
  id: string;
  name: string;
  brand: string;
  servingSize: string;
  source: 'database' | 'ai' | 'library';
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fiber: number | null;
  sodium: number | null;
  imageUrl: string | null;
}

interface ExtractedFood {
  name: string | null;
  brand: string | null;
  servingSize: string | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fiber: number | null;
  sodium: number | null;
}

function roundOrNull(value: number | undefined): number | null {
  if (value === undefined || value === null) return null;
  return Math.round(value * 10) / 10;
}

// ─── GET /nutrition/search — library-first, AI fallback ─────────────────

router.get('/search', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { q } = req.query as { q?: string };

    if (typeof q !== 'string' || q.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'q (search query) is required' });
      return;
    }

    // ── 1. Check personal library first ──────────────────────────────
    const normalized = q.trim().toLowerCase();
    const libraryItems = await UserFoodItem.find({
      userId,
      name: { $regex: normalized, $options: 'i' },
    })
      .sort({ useCount: -1, lastUsedAt: -1 })
      .limit(5)
      .lean();

    if (libraryItems.length > 0) {
      const products: FoodProduct[] = libraryItems.map((item) => ({
        id: (item._id as Types.ObjectId).toString(),
        name: item.displayName,
        brand: item.brand,
        servingSize: item.servingSize,
        source: 'library' as const,
        calories: item.calories,
        protein: item.protein,
        carbs: item.carbs,
        fat: item.fat,
        sugar: item.sugar,
        fiber: item.fiber,
        sodium: item.sodium,
        imageUrl: null,
      }));
      res.json({ success: true, data: { products, source: 'library' }, error: null });
      return;
    }

    // ── 2. Fall back to AI ────────────────────────────────────────────
    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a nutrition database. Given the food name or product query below, return a JSON array of 1-5 matching food items with accurate nutrition data per typical serving.
Input may be in English, Cantonese, or Traditional Chinese. Recognise HK local food and international brands.

Each item must have these exact fields:
- name: food name (keep original language if query is Chinese/Cantonese)
- brand: brand name if a branded product, empty string if generic food
- servingSize: use a natural, culturally appropriate serving unit — NOT just "100g". If the query is in Chinese/Cantonese, use HK Cantonese measure words (量詞), e.g. "一條" for stick-shaped foods (蟹柳/香腸), "一隻" for whole fruits (香蕉/橙), "一塊" for flat pieces (雞胸/豆腐), "一碗" for bowl foods (麵/飯/湯), "一杯" for drinks (咖啡/奶茶), "一個" for round items (雞蛋/麵包). For English queries, use natural English units like "1 medium", "1 cup", "1 slice", "1 piece".
- calories: kcal per serving (number or null)
- protein: grams per serving (number or null)
- carbs: grams per serving (number or null)
- fat: grams per serving (number or null)
- sugar: grams per serving (number or null)
- fiber: grams per serving (number or null)
- sodium: mg per serving (number or null)

Food query: "${q.trim()}"

Return ONLY a valid JSON array. No markdown, no explanation.
Example: [{"name":"雞胸肉","brand":"","servingSize":"100g","calories":165,"protein":31,"carbs":0,"fat":3.6,"sugar":0,"fiber":0,"sodium":74}]`;

    let products: FoodProduct[] = [];

    try {
      const result = await model.generateContent(prompt);
      const raw = result.response.text().trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const items = JSON.parse(jsonMatch[0]) as Record<string, unknown>[];
        if (Array.isArray(items)) {
          products = items
            .filter((item) => typeof item.name === 'string' && item.name.trim().length > 0)
            .map((item, idx) => ({
              id: `ai-${idx}`,
              name: String(item.name ?? '').trim(),
              brand: String(item.brand ?? '').trim(),
              servingSize: String(item.servingSize ?? '').trim(),
              source: 'ai' as const,
              calories: typeof item.calories === 'number' ? roundOrNull(item.calories) : null,
              protein: typeof item.protein === 'number' ? roundOrNull(item.protein) : null,
              carbs: typeof item.carbs === 'number' ? roundOrNull(item.carbs) : null,
              fat: typeof item.fat === 'number' ? roundOrNull(item.fat) : null,
              sugar: typeof item.sugar === 'number' ? roundOrNull(item.sugar) : null,
              fiber: typeof item.fiber === 'number' ? roundOrNull(item.fiber) : null,
              sodium: typeof item.sodium === 'number' ? roundOrNull(item.sodium) : null,
              imageUrl: null,
            }));
        }
      }
    } catch (aiErr) {
      console.warn('[GET /nutrition/search] AI lookup failed:', aiErr);
    }

    res.json({ success: true, data: { products, source: 'ai' }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/search]', err);
    res.status(500).json({ success: false, data: null, error: 'Food search failed' });
  }
});

// ─── POST /nutrition/ocr — Gemini vision nutrition label extraction ─────────

router.post('/ocr', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { image, mimeType } = req.body as { image?: unknown; mimeType?: unknown };

    if (typeof image !== 'string' || image.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'image (base64 string) is required' });
      return;
    }

    const resolvedMimeType =
      typeof mimeType === 'string' && mimeType.trim().length > 0 ? mimeType.trim() : 'image/jpeg';

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a nutrition label reader. Extract all nutrition information from this food packaging image.
Return a JSON object with these fields (use null for any field not found on the label):
{
  "name": "product name if visible",
  "brand": "brand name if visible",
  "servingSize": "serving size text (e.g. '30g', '1 cup')",
  "calories": number or null,
  "protein": number or null,
  "carbs": number or null,
  "fat": number or null,
  "sugar": number or null,
  "fiber": number or null,
  "sodium": number or null
}
All nutrient values should be per serving (not per 100g). Return ONLY valid JSON, no markdown.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: resolvedMimeType,
          data: image.trim(),
        },
      },
    ]);

    const raw = result.response.text().trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    let food: ExtractedFood;
    try {
      food = JSON.parse(raw) as ExtractedFood;
    } catch {
      res.json({ success: false, data: null, error: 'Could not read nutrition label' });
      return;
    }

    const usage = result.response.usageMetadata;
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=nutrition-ocr`);

    res.json({ success: true, data: { food }, aiUsage, error: null });
  } catch (err) {
    console.error('[POST /nutrition/ocr]', err);
    res.status(500).json({ success: false, data: null, error: 'OCR failed' });
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

    // Load category + body stats + custom config (if needed) in parallel
    const [categoryDoc, profileDoc] = await Promise.all([
      UserNutritionCategory.findOne({ userId }).lean(),
      HealthProfile.findOne({ userId }, { 'body.weight': 1, 'body.height': 1, 'body.age': 1, 'body.sex': 1, 'body.activityLevel': 1 }).lean(),
    ]);

    const category: NutritionCategory = categoryDoc?.category ?? 'gym';

    // Attempt personalised targets if all body stats are present
    const body = profileDoc?.body;
    const canPersonalise =
      category !== 'custom' &&
      body?.weight != null &&
      body?.height != null &&
      body?.age != null &&
      (body?.sex === 'male' || body?.sex === 'female') &&
      body?.activityLevel != null;

    let targets = CATEGORY_TARGETS[category];
    let targetBasis: 'personalised' | 'default' = 'default';
    let formula: PersonalisedFormula | null = null;

    if (category === 'custom') {
      // Use user's custom config for targets; fall back to defaults if no config saved
      const customConfigDoc = await UserNutritionCustomConfig.findOne({ userId }).lean();

      const customNutrients: string[] = customConfigDoc?.nutrients ?? DEFAULT_CUSTOM_NUTRIENTS;
      const rawGoalsMap = customConfigDoc?.goals as unknown as Map<string, number> | Record<string, number> | undefined;
      const customGoals: Record<string, number> =
        rawGoalsMap == null
          ? DEFAULT_CUSTOM_GOALS
          : rawGoalsMap instanceof Map
          ? Object.fromEntries(rawGoalsMap.entries())
          : (rawGoalsMap as Record<string, number>);

      // Build NutrientTarget array from custom config; goal value overrides CATEGORY_TARGETS default
      const defaultCustomTargets = CATEGORY_TARGETS['custom'];
      targets = customNutrients.map((nutrient) => {
        const existing = defaultCustomTargets.find((t) => t.nutrient === nutrient);
        return {
          nutrient,
          unit: existing?.unit ?? '',
          dailyTarget: customGoals[nutrient] ?? existing?.dailyTarget ?? 0,
          type: existing?.type ?? 'min',
        };
      });
      targetBasis = 'default';
    } else if (canPersonalise) {
      const result = computePersonalisedTargets(
        category,
        body!.weight!,
        body!.height!,
        body!.age!,
        body!.sex as 'male' | 'female',
        body!.activityLevel as ActivityLevel
      );
      targets = result.targets;
      formula = result.formula;
      targetBasis = 'personalised';
    }

    // Build response nutrients
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

    res.json({ success: true, data: { date: targetDate, category, nutrients, targetBasis, formula }, error: null });
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

// ─── GET /nutrition/custom-config — get user's custom nutrient config ─────

router.get('/custom-config', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const doc = await UserNutritionCustomConfig.findOne({ userId }).lean();

    if (!doc) {
      res.json({
        success: true,
        data: { nutrients: DEFAULT_CUSTOM_NUTRIENTS, goals: DEFAULT_CUSTOM_GOALS },
        error: null,
      });
      return;
    }

    const goalsMap = doc.goals as unknown as Map<string, number> | Record<string, number>;
    const goals: Record<string, number> =
      goalsMap instanceof Map
        ? Object.fromEntries(goalsMap.entries())
        : (goalsMap as Record<string, number>);

    res.json({ success: true, data: { nutrients: doc.nutrients, goals }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/custom-config]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get custom nutrient config' });
  }
});

// ─── PUT /nutrition/custom-config — save user's custom nutrient config ────

router.put('/custom-config', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { nutrients, goals } = req.body as { nutrients?: unknown; goals?: unknown };

    // Validate nutrients
    if (!Array.isArray(nutrients) || nutrients.length === 0) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'nutrients must be a non-empty array',
      });
      return;
    }

    const invalidKeys = (nutrients as unknown[]).filter(
      (k) => typeof k !== 'string' || !(VALID_NUTRIENT_KEYS as readonly string[]).includes(k)
    );

    if (invalidKeys.length > 0) {
      res.status(400).json({
        success: false,
        data: null,
        error: `Invalid nutrient keys: ${invalidKeys.join(', ')}. Valid keys: ${VALID_NUTRIENT_KEYS.join(', ')}`,
      });
      return;
    }

    // Validate goals
    if (typeof goals !== 'object' || goals === null || Array.isArray(goals)) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'goals must be an object mapping nutrient keys to numbers',
      });
      return;
    }

    const goalsObj = goals as Record<string, unknown>;
    const invalidGoalKeys = Object.keys(goalsObj).filter(
      (k) => !(VALID_NUTRIENT_KEYS as readonly string[]).includes(k)
    );
    if (invalidGoalKeys.length > 0) {
      res.status(400).json({
        success: false,
        data: null,
        error: `Invalid goal keys: ${invalidGoalKeys.join(', ')}. Valid keys: ${VALID_NUTRIENT_KEYS.join(', ')}`,
      });
      return;
    }

    const invalidGoalValues = Object.entries(goalsObj).filter(([, v]) => typeof v !== 'number');
    if (invalidGoalValues.length > 0) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'All goal values must be numbers',
      });
      return;
    }

    const validatedNutrients = nutrients as string[];
    const validatedGoals = goalsObj as Record<string, number>;

    const doc = await UserNutritionCustomConfig.findOneAndUpdate(
      { userId },
      { userId, nutrients: validatedNutrients, goals: validatedGoals, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    const savedGoalsMap = doc.goals as unknown as Map<string, number> | Record<string, number>;
    const savedGoals: Record<string, number> =
      savedGoalsMap instanceof Map
        ? Object.fromEntries(savedGoalsMap.entries())
        : (savedGoalsMap as Record<string, number>);

    res.json({ success: true, data: { nutrients: doc.nutrients, goals: savedGoals }, error: null });
  } catch (err) {
    console.error('[PUT /nutrition/custom-config]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to update custom nutrient config' });
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

// ─── GET /nutrition/library/search — search personal food library ─────────
// Must be defined before GET /nutrition/library and /:id to avoid conflicts

router.get('/library/search', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { q } = req.query as { q?: string };

    if (typeof q !== 'string' || q.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'q is required' });
      return;
    }

    const normalized = q.trim().toLowerCase();
    const items = await UserFoodItem.find({
      userId,
      name: { $regex: normalized, $options: 'i' },
    })
      .sort({ useCount: -1, lastUsedAt: -1 })
      .limit(10)
      .lean();

    res.json({ success: true, data: { items }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/library/search]', err);
    res.status(500).json({ success: false, data: null, error: 'Library search failed' });
  }
});

// ─── GET /nutrition/library — list all personal food library items ─────────

router.get('/library', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const items = await UserFoodItem.find({ userId })
      .sort({ useCount: -1, lastUsedAt: -1 })
      .lean();

    res.json({ success: true, data: { items }, error: null });
  } catch (err) {
    console.error('[GET /nutrition/library]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to get library' });
  }
});

// ─── POST /nutrition/library — save food to personal library ─────────────

router.post('/library', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { name, brand, servingSize, calories, protein, carbs, fat, sugar, fiber, sodium } = req.body as {
      name?: unknown;
      brand?: unknown;
      servingSize?: unknown;
      calories?: unknown;
      protein?: unknown;
      carbs?: unknown;
      fat?: unknown;
      sugar?: unknown;
      fiber?: unknown;
      sodium?: unknown;
    };

    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'name is required' });
      return;
    }

    const displayName = name.trim();
    const normalizedName = displayName.toLowerCase();

    // Upsert: if same normalised name exists, update nutrition data and increment useCount
    const item = await UserFoodItem.findOneAndUpdate(
      { userId, name: normalizedName },
      {
        $set: {
          displayName,
          brand: typeof brand === 'string' ? brand.trim() : '',
          servingSize: typeof servingSize === 'string' ? servingSize.trim() : '',
          calories: typeof calories === 'number' ? calories : null,
          protein: typeof protein === 'number' ? protein : null,
          carbs: typeof carbs === 'number' ? carbs : null,
          fat: typeof fat === 'number' ? fat : null,
          sugar: typeof sugar === 'number' ? sugar : null,
          fiber: typeof fiber === 'number' ? fiber : null,
          sodium: typeof sodium === 'number' ? sodium : null,
          lastUsedAt: new Date(),
        },
        $inc: { useCount: 1 },
      },
      { upsert: true, new: true }
    );

    res.status(201).json({ success: true, data: item, error: null });
  } catch (err) {
    console.error('[POST /nutrition/library]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to save to library' });
  }
});

// ─── DELETE /nutrition/library/:id — remove food from personal library ────

router.delete('/library/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, data: null, error: 'Invalid id' });
      return;
    }

    const item = await UserFoodItem.findById(id);
    if (!item) {
      res.status(404).json({ success: false, data: null, error: 'Not found' });
      return;
    }

    if (item.userId.toString() !== userId) {
      res.status(403).json({ success: false, data: null, error: 'Forbidden' });
      return;
    }

    await UserFoodItem.findByIdAndDelete(id);
    res.json({ success: true, data: { success: true }, error: null });
  } catch (err) {
    console.error('[DELETE /nutrition/library/:id]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to delete from library' });
  }
});

// ─── GET /nutrition — list meal entries for a date ────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { date } = req.query as { date?: string };
    const targetDate = typeof date === 'string' && DATE_REGEX.test(date) ? date : todayString();

    const entries = await MealEntry.find({ userId, date: targetDate }).sort({ createdAt: -1 }).lean();
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
