import { Router, Response, Request } from 'express';
import mongoose, { Types } from 'mongoose';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { CabinetItem, CabinetItemType } from '../models/CabinetItem';
import { SharedStack } from '../models/SharedStack';
import { FamilyMember } from '../models/FamilyMember';
import { SideEffect } from '../models/SideEffect';
import { MODELS } from '../config/models';

async function resolveScopedUserId(
  ownerId: Types.ObjectId,
  memberId?: string
): Promise<Types.ObjectId | null> {
  if (!memberId) return ownerId;
  if (!Types.ObjectId.isValid(memberId)) return null;
  const member = await FamilyMember.findOne({ _id: memberId, ownerId }).lean();
  if (!member) return null;
  return member._id as Types.ObjectId;
}

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

const router = Router();

// POST /cabinet — add item
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const scopedUserId = await resolveScopedUserId(ownerId, req.query.memberId as string | undefined);
  if (!scopedUserId) {
    res.status(404).json({ success: false, data: null, error: 'Family member not found' });
    return;
  }

  const { name, type, dosage, frequency, timing, brand, notes, active, startDate, endDate, source, price, currency } = req.body;

  if (!name || typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ success: false, data: null, error: 'name is required' });
    return;
  }

  const validTypes: CabinetItemType[] = ['supplement', 'medication', 'vitamin'];
  if (!type || !validTypes.includes(type)) {
    res.status(400).json({ success: false, data: null, error: 'type must be one of: supplement, medication, vitamin' });
    return;
  }

  const item = await CabinetItem.create({
    userId: scopedUserId,
    name: name.trim(),
    type,
    dosage,
    frequency,
    timing,
    brand,
    notes,
    active: active !== undefined ? active : true,
    startDate: startDate ? new Date(startDate) : new Date(),
    endDate: endDate ? new Date(endDate) : undefined,
    source: source || 'user_input',
    price: price !== undefined ? Number(price) : undefined,
    currency: currency || 'HKD',
  });

  res.status(201).json({
    success: true,
    data: { ...item.toObject(), interactions: [] },
    error: null,
  });
});

// GET /cabinet — list user's items with optional filters
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const scopedUserId = await resolveScopedUserId(ownerId, req.query.memberId as string | undefined);
  if (!scopedUserId) {
    res.status(404).json({ success: false, data: null, error: 'Family member not found' });
    return;
  }
  const query: Record<string, unknown> = { userId: scopedUserId };

  const validTypes: CabinetItemType[] = ['supplement', 'medication', 'vitamin'];
  if (req.query.type) {
    const typeParam = req.query.type as string;
    if (!validTypes.includes(typeParam as CabinetItemType)) {
      res.status(400).json({ success: false, data: null, error: 'type must be one of: supplement, medication, vitamin' });
      return;
    }
    query.type = typeParam;
  }

  if (req.query.active !== undefined) {
    if (req.query.active === 'true') {
      query.active = true;
    } else if (req.query.active === 'false') {
      query.active = false;
    } else {
      res.status(400).json({ success: false, data: null, error: 'active must be true or false' });
      return;
    }
  }

  const items = await CabinetItem.find(query).sort({ createdAt: -1 });

  res.json({
    success: true,
    data: items,
    error: null,
  });
});

// PUT /cabinet/:id — update item (PATCH semantics, owner only)
router.put('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params['id'] as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid item id' });
    return;
  }

  const item = await CabinetItem.findById(id);
  if (!item) {
    res.status(404).json({ success: false, data: null, error: 'Item not found' });
    return;
  }

  if (item.userId.toString() !== req.userId) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden' });
    return;
  }

  const allowedFields = ['name', 'type', 'dosage', 'frequency', 'timing', 'brand', 'notes', 'active', 'startDate', 'endDate', 'source', 'price', 'currency'] as const;
  type AllowedField = typeof allowedFields[number];

  const validTypes: CabinetItemType[] = ['supplement', 'medication', 'vitamin'];
  const updates: Partial<Record<AllowedField, unknown>> = {};

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      if (field === 'type' && !validTypes.includes(req.body[field])) {
        res.status(400).json({ success: false, data: null, error: 'type must be one of: supplement, medication, vitamin' });
        return;
      }
      if (field === 'source' && !['user_input', 'ai_extracted'].includes(req.body[field])) {
        res.status(400).json({ success: false, data: null, error: 'source must be one of: user_input, ai_extracted' });
        return;
      }
      if (field === 'name' && (typeof req.body[field] !== 'string' || req.body[field].trim() === '')) {
        res.status(400).json({ success: false, data: null, error: 'name cannot be empty' });
        return;
      }
      if ((field === 'startDate' || field === 'endDate') && req.body[field] !== null) {
        updates[field] = new Date(req.body[field] as string);
      } else {
        updates[field] = req.body[field];
      }
    }
  }

  const updated = await CabinetItem.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });

  res.json({
    success: true,
    data: { ...updated!.toObject(), interactions: [] },
    error: null,
  });
});

// DELETE /cabinet/:id — soft delete (set active=false + endDate=now)
router.delete('/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params['id'] as string;

  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid item id' });
    return;
  }

  const item = await CabinetItem.findById(id);
  if (!item) {
    res.status(404).json({ success: false, data: null, error: 'Item not found' });
    return;
  }

  if (item.userId.toString() !== req.userId) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden' });
    return;
  }

  // Soft delete: archive the item
  const hardDelete = req.query.hard === 'true';

  if (hardDelete) {
    await CabinetItem.findByIdAndDelete(id);
    res.json({
      success: true,
      data: { deleted: true, id },
      error: null,
    });
  } else {
    const archived = await CabinetItem.findByIdAndUpdate(
      id,
      { $set: { active: false, endDate: new Date() } },
      { new: true }
    );
    res.json({
      success: true,
      data: archived,
      error: null,
    });
  }
});

// POST /cabinet/share — create shareable link for active stack
router.post('/share', async (req: AuthRequest, res: Response): Promise<void> => {
  const token = crypto.randomBytes(6).toString('hex'); // 12-char hex
  await SharedStack.create({ token, userId: req.userId });

  const frontendUrl = process.env.FRONTEND_URL ?? 'https://recallth-web.vercel.app';
  const shareUrl = `${frontendUrl}/shared-stack/${token}`;

  res.status(201).json({ success: true, error: null, data: { token, shareUrl } });
});

// GET /cabinet/shared/:token — public view of a shared stack (no auth)
router.get('/shared/:token', async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params as { token: string };

  const shared = await SharedStack.findOne({ token }).lean();
  if (!shared) {
    res.status(404).json({ success: false, error: 'Shared stack not found', data: null });
    return;
  }

  const items = await CabinetItem.find({ userId: shared.userId, active: true })
    .select('name type dosage frequency timing brand')
    .lean();

  res.json({ success: true, error: null, data: { items } });
});

// GET /cabinet/budget-summary — monthly spend summary
router.get('/budget-summary', async (req: AuthRequest, res: Response): Promise<void> => {
  const items = await CabinetItem.find({ userId: req.userId, active: true, price: { $exists: true, $ne: null } }).lean();

  const priced = items.filter((i) => i.price !== undefined && i.price !== null);
  const totalMonthly = priced.reduce((sum, i) => sum + (i.price ?? 0), 0);

  res.json({
    success: true,
    error: null,
    data: {
      totalMonthly,
      currency: priced[0]?.currency ?? 'HKD',
      items: priced.map((i) => ({ name: i.name, price: i.price, currency: i.currency ?? 'HKD' })),
    },
  });
});

// POST /cabinet/scan — OCR a supplement bottle label via Gemini Vision
router.post('/scan', async (req: AuthRequest, res: Response): Promise<void> => {
  const { imageBase64, mimeType } = req.body as { imageBase64?: string; mimeType?: string };

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ success: false, data: null, error: 'imageBase64 is required' });
    return;
  }

  const validMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  const resolvedMime = (mimeType && validMimeTypes.includes(mimeType)) ? mimeType : 'image/jpeg';

  try {
    const model = getGenAI().getGenerativeModel({ model: MODELS.EXTRACTION });

    const prompt = `You are analysing a photo of a supplement or medication bottle label. Extract the following fields and return ONLY valid JSON.

Extract:
{
  "name": string,         // product name (e.g. "Magnesium Glycinate")
  "brand": string | null, // brand/manufacturer (e.g. "NOW Foods")
  "type": string,         // one of: "supplement", "medication", "vitamin"
  "dosage": string | null,// dosage per serving (e.g. "400mg", "2 capsules")
  "servingSize": string | null, // serving size if different from dosage
  "ingredients": string | null  // key active ingredients, comma separated
}

Rules:
- If you cannot read the label clearly, extract what you can and set unclear fields to null
- "type" must be one of the three values above — default to "supplement" if unsure
- Do not invent values — only extract what is visibly on the label
- Return ONLY valid JSON, no markdown fences`;

    const result = await model.generateContent([
      prompt,
      { inlineData: { mimeType: resolvedMime, data: imageBase64 } },
    ]);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.EXTRACTION} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=label-scan`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse label — try a clearer photo' });
      return;
    }

    res.json({ success: true, error: null, data: extracted });
  } catch (err) {
    console.error('[POST /cabinet/scan]', err);
    res.status(500).json({ success: false, data: null, error: 'Scan failed' });
  }
});

// GET /cabinet/deal-finder — AI buying tips for each active supplement
router.get('/deal-finder', async (req: AuthRequest, res: Response): Promise<void> => {
  const items = await CabinetItem.find({ userId: req.userId, active: true }).lean();

  if (items.length === 0) {
    res.json({ success: true, error: null, data: [] });
    return;
  }

  const supplementList = items.map((i) => `${i.name}${i.brand ? ` (${i.brand})` : ''}`).join('\n');

  const prompt = `You are a supplement buying advisor for Hong Kong shoppers. For each supplement below, give 1–2 practical buying tips for HK shoppers — best platform to buy from, typical price range in HKD, and any money-saving tips (e.g. buy in bulk, subscribe & save, iHerb coupon codes).

Supplements:
${supplementList}

Return ONLY valid JSON array. For each supplement, one object:
{
  "itemName": string,
  "tips": string,       // 1-2 sentences of practical advice
  "bestPlatform": string // e.g. "iHerb HK", "HKTVmall", "Mannings", "Watsons", "iHerb.com"
}

Do NOT include markdown fences. Return only the JSON array.`;

  try {
    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=deal-finder`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let tips: Array<{ itemName: string; tips: string; bestPlatform: string }>;
    try {
      tips = JSON.parse(cleaned) as typeof tips;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    res.json({ success: true, error: null, data: tips });
  } catch (err) {
    console.error('[GET /cabinet/deal-finder]', err);
    res.status(500).json({ success: false, data: null, error: 'Deal finder failed' });
  }
});

// GET /cabinet/reaction-insights — AI-powered pattern analysis of side effect logs
router.get('/reaction-insights', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  const logs = await SideEffect.find({ userId }).lean();

  if (logs.length === 0) {
    res.json({
      success: true,
      data: {
        insights: [],
        generatedAt: new Date().toISOString(),
        message: 'Log more reactions to unlock pattern insights.',
      },
      error: null,
    });
    return;
  }

  // Group by supplementName + symptom (normalised to lowercase)
  type GroupKey = string; // `${cabinetItemId}::${symptom_lower}`
  const groups = new Map<GroupKey, {
    cabinetItemId: string;
    symptom: string;
    dates: string[];
    ratings: number[];
  }>();

  // Resolve cabinetItemId → name using current cabinet items
  const itemIds = [...new Set(logs.map((l) => l.cabinetItemId.toString()))];
  const cabinetItems = await CabinetItem.find({ _id: { $in: itemIds } }).lean();
  const itemNameMap = new Map(cabinetItems.map((i) => [(i._id as Types.ObjectId).toString(), i.name]));

  for (const log of logs) {
    const itemId = log.cabinetItemId.toString();
    const symptomLower = log.symptom.toLowerCase().trim();
    const key: GroupKey = `${itemId}::${symptomLower}`;

    if (!groups.has(key)) {
      groups.set(key, { cabinetItemId: itemId, symptom: log.symptom, dates: [], ratings: [] });
    }
    const g = groups.get(key)!;
    g.dates.push(new Date(log.date).toISOString().slice(0, 10));
    g.ratings.push(log.rating);
  }

  // Only include groups with 2+ occurrences
  const qualifying = [...groups.values()].filter((g) => g.dates.length >= 2);

  if (qualifying.length === 0) {
    res.json({
      success: true,
      data: {
        insights: [],
        generatedAt: new Date().toISOString(),
        message: 'Log more reactions to unlock pattern insights.',
      },
      error: null,
    });
    return;
  }

  const patternList = qualifying.map((g) => {
    const name = itemNameMap.get(g.cabinetItemId) ?? 'Unknown supplement';
    const avgRating = (g.ratings.reduce((a, b) => a + b, 0) / g.ratings.length).toFixed(1);
    return `- Supplement: ${name} | Symptom: ${g.symptom} | Occurrences: ${g.dates.length} | Avg severity: ${avgRating}/5 | Dates: ${g.dates.join(', ')}`;
  }).join('\n');

  const prompt = `You are a health advisor analysing supplement reaction logs. For each pattern below, generate a plain-language insight and actionable recommendation. Be empathetic and practical. Do NOT give medical diagnoses. Always suggest consulting a healthcare provider for major concerns.

Patterns (2+ occurrences of same symptom with same supplement):
${patternList}

Return ONLY valid JSON array. Each object:
{
  "supplementName": string,
  "symptom": string,
  "occurrences": number,
  "insight": string,        // 1 sentence describing the pattern
  "recommendation": string, // 1-2 sentences of actionable advice
  "severity": "mild" | "moderate" | "major"
}

Do NOT include markdown fences. Return only the JSON array.`;

  try {
    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=reaction-insights`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let aiInsights: Array<{
      supplementName: string;
      symptom: string;
      occurrences: number;
      insight: string;
      recommendation: string;
      severity: 'mild' | 'moderate' | 'major';
    }>;
    try {
      aiInsights = JSON.parse(cleaned) as typeof aiInsights;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    // Enrich with loggedDates from the original groups
    const insights = aiInsights.map((ai) => {
      const match = qualifying.find(
        (g) =>
          (itemNameMap.get(g.cabinetItemId) ?? '').toLowerCase() === ai.supplementName.toLowerCase() &&
          g.symptom.toLowerCase() === ai.symptom.toLowerCase()
      );
      return {
        ...ai,
        loggedDates: match?.dates ?? [],
      };
    });

    res.json({
      success: true,
      data: {
        insights,
        generatedAt: new Date().toISOString(),
      },
      error: null,
    });
  } catch (err) {
    console.error('[GET /cabinet/reaction-insights]', err);
    res.status(500).json({ success: false, data: null, error: 'Reaction insights failed' });
  }
});

// GET /cabinet/schedule — group active items by time-of-day slot
router.get('/schedule', async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const scopedUserId = await resolveScopedUserId(ownerId, req.query.memberId as string | undefined);
  if (!scopedUserId) {
    res.status(404).json({ success: false, data: null, error: 'Family member not found' });
    return;
  }

  const items = await CabinetItem.find({ userId: scopedUserId, active: true }).lean();

  type Slot = 'morning' | 'afternoon' | 'evening' | 'night' | 'anytime';

  const SLOT_KEYWORDS: Record<Slot, string[]> = {
    morning: ['morning', 'am', 'wake up', 'breakfast', 'empty stomach'],
    afternoon: ['afternoon', 'lunch', 'midday'],
    evening: ['evening', 'dinner', 'pm', 'with dinner'],
    night: ['night', 'bedtime', 'before bed', 'sleep'],
    anytime: [],
  };

  function classifyTiming(timing?: string): Slot {
    if (!timing) return 'anytime';
    const lower = timing.toLowerCase();
    for (const slot of (['morning', 'afternoon', 'evening', 'night'] as Slot[])) {
      if (SLOT_KEYWORDS[slot].some((kw) => lower.includes(kw))) return slot;
    }
    return 'anytime';
  }

  const schedule: Record<Slot, Array<{ id: string; name: string; dosage?: string; timing?: string; type: string }>> = {
    morning: [],
    afternoon: [],
    evening: [],
    night: [],
    anytime: [],
  };

  for (const item of items) {
    const slot = classifyTiming(item.timing);
    schedule[slot].push({
      id: (item._id as Types.ObjectId).toString(),
      name: item.name,
      dosage: item.dosage,
      timing: item.timing,
      type: item.type,
    });
  }

  res.json({
    success: true,
    error: null,
    data: {
      schedule,
      totalActive: items.length,
    },
  });
});

export default router;
