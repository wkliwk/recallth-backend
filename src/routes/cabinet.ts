import { Router, Response, Request } from 'express';
import mongoose, { Types } from 'mongoose';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AuthRequest } from '../middleware/auth';
import { CabinetItem, CabinetItemType } from '../models/CabinetItem';
import { SharedStack } from '../models/SharedStack';
import { FamilyMember } from '../models/FamilyMember';
import { SideEffect } from '../models/SideEffect';
import { HealthProfile } from '../models/HealthProfile';
import { MODELS } from '../config/models';
import { InsightCache } from '../models/InsightCache';

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

// ─── Evidence scores cache (in-memory, 24-hour TTL per user) ─────────────────

interface EvidenceScore {
  name: string;
  level: 'A' | 'B' | 'C' | 'D';
  rationale: string;
}

const evidenceCache = new Map<string, { scores: EvidenceScore[]; expiresAt: number }>();
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function bustEvidenceCache(userId: string) {
  evidenceCache.delete(userId);
}

// ─── Redundancy cache (in-memory, 1-hour TTL per user) ───────────────────────

interface RedundancyEntry {
  items: string[];
  nutrient: string;
  risk: 'low' | 'moderate' | 'high';
  explanation: string;
  recommendation: string;
}

const redundancyCache = new Map<string, { redundancies: RedundancyEntry[]; expiresAt: number }>();
const REDUNDANCY_TTL_MS = 60 * 60 * 1000; // 1 hour

function bustRedundancyCache(userId: string) {
  redundancyCache.delete(userId);
}

// ─── Research notes helper ────────────────────────────────────────────────────

async function generateResearchNotes(itemId: string, name: string, type: string): Promise<void> {
  try {
    const prompt = `You are a evidence-based health advisor. Provide a concise research summary for the supplement or medication below.

Name: ${name}
Type: ${type}

Return ONLY valid JSON (no markdown fences):
{
  "summary": string,       // 2-3 sentences: what it does, key benefits
  "commonDosage": string,  // e.g. "500–1000mg daily with meals"
  "cautions": string       // e.g. "Avoid if on blood thinners. Consult a doctor if pregnant."
}

Important: Include a note that this is general information, not personalised medical advice.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(cleaned) as {
      summary: string;
      commonDosage: string;
      cautions: string;
    };

    await CabinetItem.findByIdAndUpdate(itemId, {
      researchNotes: {
        summary: parsed.summary,
        commonDosage: parsed.commonDosage,
        cautions: parsed.cautions,
        generatedAt: new Date(),
      },
    });

    console.log(`[AI] research notes generated for item ${itemId} (${name})`);
  } catch (err) {
    // Non-fatal — item creation is not affected
    console.error(`[AI] research notes generation failed for ${name}:`, err);
  }
}

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

  bustEvidenceCache(String(req.userId));
  bustRedundancyCache(String(req.userId));

  // Fire-and-forget research notes generation (non-blocking)
  void generateResearchNotes((item._id as Types.ObjectId).toString(), item.name, item.type);
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

  const items = await CabinetItem.find(query).sort({ createdAt: -1 }).lean();

  const itemsWithComputed = items.map((item) => {
    const threshold = item.restockThresholdDays ?? 7;
    let daysSupplyRemaining: number | null = null;
    let lowSupplyWarning = false;
    if (item.quantityRemaining != null && item.dailyDoseCount != null && item.dailyDoseCount > 0) {
      daysSupplyRemaining = Math.floor(item.quantityRemaining / item.dailyDoseCount);
      lowSupplyWarning = daysSupplyRemaining <= threshold;
    }
    return { ...item, daysSupplyRemaining, lowSupplyWarning };
  });

  res.json({
    success: true,
    data: itemsWithComputed,
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

  const allowedFields = ['name', 'type', 'dosage', 'frequency', 'timing', 'brand', 'notes', 'active', 'startDate', 'endDate', 'source', 'price', 'currency', 'quantityRemaining', 'dailyDoseCount', 'restockThresholdDays'] as const;
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

  const nameChanged = updates.name !== undefined && updates.name !== item.name;
  const updated = await CabinetItem.findByIdAndUpdate(id, { $set: updates }, { new: true, runValidators: true });

  bustEvidenceCache(String(req.userId));
  bustRedundancyCache(String(req.userId));

  res.json({
    success: true,
    data: { ...updated!.toObject(), interactions: [] },
    error: null,
  });

  // Regenerate research notes if name changed (fire-and-forget)
  if (nameChanged) {
    void generateResearchNotes(id, updated!.name, updated!.type);
  }
});

// POST /cabinet/:id/refresh-research — manually trigger research notes regeneration
router.post('/:id/refresh-research', async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params['id'] as string;

  if (!Types.ObjectId.isValid(id)) {
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

  res.status(202).json({ success: true, data: { message: 'Research notes regeneration queued.' }, error: null });

  // Fire-and-forget
  void generateResearchNotes(id, item.name, item.type);
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

  bustEvidenceCache(String(req.userId));
  bustRedundancyCache(String(req.userId));

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

// GET /cabinet/schedule/optimized — AI-powered timing optimizer with interaction awareness
router.get('/schedule/optimized', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const ownerId = new Types.ObjectId(req.userId);
    const scopedUserId = await resolveScopedUserId(ownerId, req.query.memberId as string | undefined);
    if (!scopedUserId) {
      res.status(404).json({ success: false, data: null, error: 'Family member not found' });
      return;
    }

    const [items, profile] = await Promise.all([
      CabinetItem.find({ userId: scopedUserId, active: true }).lean(),
      HealthProfile.findOne({ userId: scopedUserId }).lean(),
    ]);

    if (items.length === 0) {
      res.json({
        success: true,
        error: null,
        data: {
          schedule: [],
          optimizationNotes: 'No active supplements in your cabinet.',
        },
      });
      return;
    }

    // Parse lifestyle params from query
    const wakeTime = (req.query.wakeTime as string | undefined) ?? '07:00';
    const sleepTime = (req.query.sleepTime as string | undefined) ?? '23:00';
    const mealTimesRaw = req.query.mealTimes as string | undefined;
    const mealTimes = mealTimesRaw
      ? mealTimesRaw.split(',').map((t) => t.trim()).filter(Boolean)
      : ['08:00', '13:00', '19:00'];
    const workoutTime = (req.query.workoutTime as string | undefined) ?? null;

    const hasCustomLifestyle = !!(req.query.wakeTime || req.query.sleepTime || req.query.mealTimes || req.query.workoutTime);

    // Build supplement context
    const supplementList = items
      .map((i) => {
        const parts = [`- ${i.name} (${i.type})`];
        if (i.dosage) parts[0] += `, dosage: ${i.dosage}`;
        if (i.timing) parts[0] += `, timing hint: ${i.timing}`;
        return parts[0];
      })
      .join('\n');

    // Build profile context
    const profileParts: string[] = [];
    if (profile?.body?.age) profileParts.push(`Age: ${profile.body.age}`);
    if (profile?.body?.sex) profileParts.push(`Sex: ${profile.body.sex}`);
    if (profile?.diet?.dietType) profileParts.push(`Diet: ${profile.diet.dietType}`);
    if (profile?.exercise?.intensity) profileParts.push(`Exercise intensity: ${profile.exercise.intensity}`);
    if (profile?.goals?.primary?.length) profileParts.push(`Health goals: ${profile.goals.primary.join(', ')}`);
    const profileContext = profileParts.length > 0 ? profileParts.join('\n') : 'Not provided';

    const prompt = `You are an expert nutritionist and supplement timing specialist. Your job is to create an optimised daily supplement schedule based on the user's active supplements and lifestyle.

User lifestyle:
- Wake time: ${wakeTime}
- Sleep time: ${sleepTime}
- Meal times: ${mealTimes.join(', ')}
${workoutTime ? `- Workout time: ${workoutTime}` : '- No workout scheduled'}
${hasCustomLifestyle ? '' : '\nNote: No lifestyle params provided — use the times above as sensible defaults.'}

User health profile:
${profileContext}

Active supplements:
${supplementList}

Scheduling rules to apply:
1. Fat-soluble vitamins (A, D, E, K) MUST be taken with a meal containing fat
2. Calcium and iron should NOT be taken together — separate by at least 2 hours
3. Magnesium is best taken 30–60 minutes before bed to aid sleep
4. Vitamin C enhances iron absorption — consider pairing them
5. B vitamins are best taken in the morning to avoid disrupting sleep
6. Probiotics are best on an empty stomach (30 min before meals) or with food per product type
7. Fish oil / omega-3s should be taken with meals to reduce GI upset and improve absorption
8. Zinc should not be taken with calcium or iron
9. Caffeine-containing supplements (e.g. green tea extract) should be taken in the morning
10. Pre-workout supplements should be timed 30 min before workout
11. If no specific conflicts apply, spread supplements across meals to reduce GI load

Create 3–6 time slots across the day. Each slot should have a specific time (based on the user's lifestyle) and a descriptive label. Assign each supplement to the most appropriate slot with a plain-English reason.

Return ONLY valid JSON (no markdown fences):
{
  "schedule": [
    {
      "time": string,
      "label": string,
      "supplements": [
        {
          "id": string,
          "name": string,
          "dosage": string | null,
          "reason": string
        }
      ]
    }
  ],
  "optimizationNotes": string
}

Rules:
- "id" must be exactly the supplement id provided below
- "time" must be in HH:MM 24-hour format
- "label" should be descriptive, e.g. "Morning (with breakfast)", "Before bed"
- "reason" should be 1 sentence explaining WHY this timing — mention conflicts, absorption, food requirements
- "optimizationNotes" is a 2-3 sentence summary of the key timing decisions, especially any conflicts resolved
- Every active supplement must appear in exactly one slot
- Sort slots chronologically by time
- This is general information, not personalised medical advice

Supplement IDs for reference:
${items.map((i) => `- id: ${(i._id as Types.ObjectId).toString()} | name: ${i.name}`).join('\n')}`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=schedule-optimizer`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    type OptimizedSupplement = {
      id: string;
      name: string;
      dosage: string | null;
      reason: string;
    };

    type OptimizedSlot = {
      time: string;
      label: string;
      supplements: OptimizedSupplement[];
    };

    type OptimizedSchedule = {
      schedule: OptimizedSlot[];
      optimizationNotes: string;
    };

    let parsed: OptimizedSchedule;
    try {
      parsed = JSON.parse(cleaned) as OptimizedSchedule;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    // Validate every item is accounted for — if any are missing, note it
    const scheduledIds = new Set(
      parsed.schedule.flatMap((slot) => slot.supplements.map((s) => s.id))
    );
    const missingItems = items.filter((i) => !scheduledIds.has((i._id as Types.ObjectId).toString()));
    if (missingItems.length > 0) {
      const missingNames = missingItems.map((i) => i.name).join(', ');
      parsed.optimizationNotes += ` Note: ${missingNames} could not be scheduled — please review their timing manually.`;
    }

    res.json({
      success: true,
      error: null,
      data: parsed,
    });
  } catch (err) {
    console.error('[GET /cabinet/schedule/optimized]', err);
    res.status(500).json({ success: false, data: null, error: 'Schedule optimization failed' });
  }
});

// GET /cabinet/restock-alerts — items with low supply warning
router.get('/restock-alerts', async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const scopedUserId = await resolveScopedUserId(ownerId, req.query.memberId as string | undefined);
  if (!scopedUserId) {
    res.status(404).json({ success: false, data: null, error: 'Family member not found' });
    return;
  }

  const items = await CabinetItem.find({ userId: scopedUserId, active: true }).lean();

  const alerts = items
    .filter((item) => {
      if (item.quantityRemaining == null || item.dailyDoseCount == null || item.dailyDoseCount <= 0) return false;
      const daysSupply = Math.floor(item.quantityRemaining / item.dailyDoseCount);
      const threshold = item.restockThresholdDays ?? 7;
      return daysSupply <= threshold;
    })
    .map((item) => ({
      id: (item._id as Types.ObjectId).toString(),
      name: item.name,
      daysSupplyRemaining: Math.floor(item.quantityRemaining! / item.dailyDoseCount!),
      quantityRemaining: item.quantityRemaining!,
    }));

  res.json({ success: true, data: { alerts }, error: null });
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

// POST /cabinet/ai-lookup — AI product search for supplement/medication info
router.post('/ai-lookup', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      res.status(400).json({ success: false, data: null, error: 'query is required' });
      return;
    }

    const genAI = getGenAI();
    const model = genAI.getGenerativeModel({ model: MODELS.CHAT });

    const prompt = `You are a supplement product expert. The user is searching for: "${query.trim()}"

Return up to 3 matching supplement or health product results as a JSON array. Each result must have:
- name: product name (string, required)
- brand: brand name (string, required)
- type: one of "supplement", "vitamin", "medication" (string, required)
- dosage: typical serving size e.g. "25g", "2 scoops", "1 capsule" (string, required)
- frequency: one of "Daily", "Twice daily", "As needed" (string, required)
- timing: one of "Morning", "Pre-workout", "With meals", "Evening", "Before bed" (string, required)
- description: 1-2 sentence product description (string, required)
- ingredients: key active ingredients e.g. "Whey Protein Isolate, Whey Protein Concentrate" (string, required)
- imageUrl: leave as empty string "" (string, required)

Return ONLY a valid JSON array, no markdown, no explanation.
Example: [{"name":"Gold Standard 100% Whey","brand":"Optimum Nutrition","type":"supplement","dosage":"30.4g (1 scoop)","frequency":"Daily","timing":"Post-workout","description":"Premium whey protein blend with 24g of protein per serving.","ingredients":"Whey Protein Isolate, Whey Protein Concentrate, Whey Peptides","imageUrl":""}]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      res.status(500).json({ success: false, data: null, error: 'AI returned unexpected format' });
      return;
    }

    const products = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(products) || products.length === 0) {
      res.status(404).json({ success: false, data: null, error: 'No products found for that query' });
      return;
    }

    res.json({ success: true, data: products.slice(0, 3), error: null });
  } catch (err) {
    console.error('[POST /cabinet/ai-lookup]', err);
    res.status(500).json({ success: false, data: null, error: 'AI lookup failed' });
  }
});

// POST /cabinet/stack-builder — AI-recommended supplement stack from health goals
router.post('/stack-builder', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.userId);
    const scopedUserId = await resolveScopedUserId(userId, req.query.memberId as string | undefined);
    if (!scopedUserId) {
      res.status(404).json({ success: false, data: null, error: 'Family member not found' });
      return;
    }

    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId: scopedUserId }).lean(),
      CabinetItem.find({ userId: scopedUserId, active: true }).lean(),
    ]);

    const overrideGoals = req.body?.goals as string[] | undefined;
    const profileGoals = profile?.goals?.primary ?? [];
    const goalsToUse = overrideGoals && overrideGoals.length > 0 ? overrideGoals : profileGoals;

    const cabinetList = cabinetItems.map((i) => `${i.name} (${i.type}${i.dosage ? `, ${i.dosage}` : ''})`).join(', ') || 'None';

    const profileContext = [
      profile?.body?.age ? `Age: ${profile.body.age}` : null,
      profile?.body?.sex ? `Sex: ${profile.body.sex}` : null,
      profile?.body?.weight ? `Weight: ${profile.body.weight}kg` : null,
      profile?.exercise?.intensity ? `Exercise intensity: ${profile.exercise.intensity}` : null,
      profile?.diet?.dietType ? `Diet: ${profile.diet.dietType}` : null,
      profile?.diet?.allergies?.length ? `Allergies: ${profile.diet.allergies.join(', ')}` : null,
      profile?.lifestyle?.stressLevel ? `Stress level: ${profile.lifestyle.stressLevel}` : null,
      profile?.sleep?.quality ? `Sleep quality: ${profile.sleep.quality}` : null,
    ].filter(Boolean).join('\n') || 'Not provided';

    const prompt = `You are an evidence-based health advisor. Based on the user's profile and health goals, recommend a personalised supplement stack.

User profile:
${profileContext}

Health goals: ${goalsToUse.length > 0 ? goalsToUse.join(', ') : 'Not specified'}

Current active supplements: ${cabinetList}

Recommend the top 6-8 most relevant supplements for this user. For each, specify whether they already have it.

Return ONLY valid JSON (no markdown fences):
{
  "recommended": [
    {
      "name": string,
      "reason": string,
      "alreadyInCabinet": boolean,
      "priority": "essential" | "beneficial" | "optional",
      "suggestedDosage": string,
      "timing": string
    }
  ],
  "interactionWarnings": string[],
  "notesOnCurrentStack": string
}

Rules:
- Base recommendations on evidence-based research
- Mark alreadyInCabinet: true if the supplement name matches any in the current cabinet (case-insensitive)
- interactionWarnings: mention any notable interactions between recommended additions and the current stack
- notesOnCurrentStack: 1-2 sentence qualitative summary of the user's existing supplements
- This is general information, not personalised medical advice`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=stack-builder`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    type RecommendedItem = {
      name: string;
      reason: string;
      alreadyInCabinet: boolean;
      priority: 'essential' | 'beneficial' | 'optional';
      suggestedDosage: string;
      timing: string;
    };

    let parsed: { recommended: RecommendedItem[]; interactionWarnings: string[]; notesOnCurrentStack: string };
    try {
      parsed = JSON.parse(cleaned) as typeof parsed;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    // Ensure alreadyInCabinet flags are accurate based on actual cabinet
    const cabinetNames = cabinetItems.map((i) => i.name.toLowerCase());
    parsed.recommended = parsed.recommended.map((r) => ({
      ...r,
      alreadyInCabinet: cabinetNames.some((n) => n === r.name.toLowerCase()),
    }));

    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[POST /cabinet/stack-builder]', err);
    res.status(500).json({ success: false, data: null, error: 'Stack builder failed' });
  }
});

// GET /cabinet/seasonal-recommendations — AI seasonal supplement suggestions
router.get('/seasonal-recommendations', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = new Types.ObjectId(req.userId);
    const scopedUserId = await resolveScopedUserId(userId, req.query.memberId as string | undefined);
    if (!scopedUserId) {
      res.status(404).json({ success: false, data: null, error: 'Family member not found' });
      return;
    }

    const hemisphere = (req.query.hemisphere as string) === 'southern' ? 'southern' : 'northern';

    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId: scopedUserId }).lean(),
      CabinetItem.find({ userId: scopedUserId, active: true }).lean(),
    ]);

    const now = new Date();
    const month = now.getMonth() + 1; // 1-12

    function getSeason(m: number, hemi: string): string {
      const isNorthern = hemi === 'northern';
      if (m >= 3 && m <= 5) return isNorthern ? 'Spring' : 'Autumn';
      if (m >= 6 && m <= 8) return isNorthern ? 'Summer' : 'Winter';
      if (m >= 9 && m <= 11) return isNorthern ? 'Autumn' : 'Spring';
      return isNorthern ? 'Winter' : 'Summer';
    }

    const season = getSeason(month, hemisphere);
    const seasonLabel = `${season} (${hemisphere === 'northern' ? 'Northern' : 'Southern'} Hemisphere)`;

    const cabinetList = cabinetItems.map((i) => i.name).join(', ') || 'None';
    const goals = profile?.goals?.primary?.join(', ') || 'Not specified';

    const prompt = `You are a health advisor. Today is ${now.toISOString().slice(0, 10)}, currently ${seasonLabel}.

Based on the season and the user's context, recommend 4-6 supplements that are especially relevant right now.

User health goals: ${goals}
Current supplements: ${cabinetList}

Return ONLY valid JSON (no markdown fences):
{
  "season": "${seasonLabel}",
  "rationale": string,
  "recommendations": [
    {
      "name": string,
      "reason": string,
      "alreadyInCabinet": boolean,
      "priority": "high" | "medium" | "low"
    }
  ],
  "currentCabinetNotes": string
}

Rules:
- rationale: 1-2 sentences on why this season matters for supplementation
- Mark alreadyInCabinet: true if the name matches a supplement in the current cabinet (case-insensitive)
- currentCabinetNotes: 1-2 sentences on how their current stack aligns with seasonal needs
- Provide evidence-based, practical recommendations
- This is general information, not personalised medical advice`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);

    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=seasonal-recommendations`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    type SeasonalRec = {
      name: string;
      reason: string;
      alreadyInCabinet: boolean;
      priority: 'high' | 'medium' | 'low';
    };

    let parsed: { season: string; rationale: string; recommendations: SeasonalRec[]; currentCabinetNotes: string };
    try {
      parsed = JSON.parse(cleaned) as typeof parsed;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    // Correct alreadyInCabinet based on actual cabinet
    const cabinetNames = cabinetItems.map((i) => i.name.toLowerCase());
    parsed.recommendations = parsed.recommendations.map((r) => ({
      ...r,
      alreadyInCabinet: cabinetNames.some((n) => n === r.name.toLowerCase()),
    }));

    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[GET /cabinet/seasonal-recommendations]', err);
    res.status(500).json({ success: false, data: null, error: 'Seasonal recommendations failed' });
  }
});

// GET /cabinet/cycle-alerts — AI-recommended cycling alerts for long-running supplements
router.get('/cycle-alerts', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const items = await CabinetItem.find({ userId, active: true }).lean();
    if (items.length === 0) {
      res.json({ success: true, data: { alerts: [] } });
      return;
    }

    const now = Date.now();
    const supplementList = items.map((item) => {
      const daysTaken = Math.floor((now - new Date(item.createdAt as Date).getTime()) / 86400000);
      return { id: String(item._id), name: item.name, type: item.type, daysTaken };
    });

    const prompt = `You are an evidence-based health advisor reviewing a user's supplement and medication history.
The user has been taking the following for the indicated number of days:

${supplementList.map((s) => `- ${s.name} (${s.type}): ${s.daysTaken} days`).join('\n')}

Identify ONLY the items where cycling off is genuinely recommended based on established evidence (e.g. tolerance build-up, safety limits, typical cycle protocols). Ignore items with no known cycling concerns.

Return ONLY valid JSON (no markdown fences):
{
  "alerts": [
    {
      "id": "<same id as input>",
      "name": "<supplement name>",
      "daysTaken": <number>,
      "recommendation": "<concise action, e.g. 'Consider a 1–2 week break'>",
      "reason": "<1–2 sentence evidence-based rationale>"
    }
  ]
}

If no items need cycling attention, return { "alerts": [] }.
This is general information, not personalised medical advice.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=cycle-alerts`
    );

    let raw = result.response.text().trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();

    const parsed = JSON.parse(raw) as { alerts: Array<{ id: string; name: string; daysTaken: number; recommendation: string; reason: string }> };

    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('[GET /cabinet/cycle-alerts]', err);
    res.status(500).json({ success: false, data: null, error: 'Cycle alerts failed' });
  }
});

// POST /cabinet/doctor-questions — AI-suggested questions to ask a doctor
router.post('/doctor-questions', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const userObjectId = new Types.ObjectId(userId);

    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId: userObjectId }).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
    ]);

    const supplementList = cabinetItems.length > 0
      ? cabinetItems.map((i) => {
          const parts = [i.name];
          if (i.dosage) parts.push(`dosage: ${i.dosage}`);
          if (i.frequency) parts.push(`frequency: ${i.frequency}`);
          return `- ${parts.join(', ')}`;
        }).join('\n')
      : 'No active supplements or medications.';

    const goals = profile?.goals?.primary?.join(', ') || 'Not specified';
    const allergies = profile?.diet?.allergies?.join(', ') || 'None reported';
    const conditions = profile?.diet?.intolerances?.join(', ') || 'None reported';

    const prompt = `You are an evidence-based health advisor helping a user prepare for a doctor visit.

The user is currently taking the following supplements and medications:
${supplementList}

Health goals: ${goals}
Allergies: ${allergies}
Known conditions / intolerances: ${conditions}

Based on this information, generate 3–5 specific, evidence-based questions the user should ask their doctor. Focus on:
- Potential interactions between their supplements/medications
- Whether dosages are appropriate for their goals
- Safety concerns based on known conditions or allergies
- Evidence gaps or areas where medical guidance is especially important

Return ONLY valid JSON (no markdown fences):
{
  "questions": [
    "<question 1>",
    "<question 2>",
    "<question 3>"
  ]
}

This is general health information, not personalised medical advice.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=doctor-questions`
    );

    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: { questions: string[] };
    try {
      parsed = JSON.parse(cleaned) as { questions: string[] };
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    res.json({ success: true, data: { questions: parsed.questions } });
  } catch (err) {
    console.error('[POST /cabinet/doctor-questions]', err);
    res.status(500).json({ success: false, data: null, error: 'Doctor questions failed' });
  }
});

// ─── GET /cabinet/evidence-scores ────────────────────────────────────────────

router.get('/evidence-scores', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;

  // Return cached result if fresh
  const cached = evidenceCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    res.json({ success: true, data: { scores: cached.scores }, error: null });
    return;
  }

  try {
    const userObjectId = new Types.ObjectId(userId);
    const items = await CabinetItem.find({ userId: userObjectId, active: true }).lean();

    if (items.length === 0) {
      res.json({ success: true, data: { scores: [] }, error: null });
      return;
    }

    const itemList = items.map((i) => ({ name: i.name, type: i.type }));
    const prompt = `For each supplement/medication listed below, assign an evidence level (A/B/C/D) based on the strength of published human clinical research supporting its claimed benefits. Use these definitions:
A = Strong evidence from multiple RCTs or systematic reviews
B = Moderate evidence from some RCTs or observational studies
C = Limited or mixed evidence — some studies but results are inconsistent
D = Little to no human evidence — primarily anecdotal or preclinical

Items:
${JSON.stringify(itemList)}

Return ONLY valid JSON array (no markdown, no extra text):
[{"name": "...", "level": "A", "rationale": "One sentence explaining why."}]

If you don't recognise an item, assign D and say so in the rationale.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: EvidenceScore[];
    try {
      parsed = JSON.parse(cleaned) as EvidenceScore[];
      // Validate and normalise
      parsed = parsed
        .filter((s) => s.name && ['A', 'B', 'C', 'D'].includes(s.level))
        .map((s) => ({ name: s.name, level: s.level, rationale: s.rationale ?? '' }));
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse evidence scores from AI' });
      return;
    }

    evidenceCache.set(userId, { scores: parsed, expiresAt: Date.now() + EVIDENCE_TTL_MS });
    res.json({ success: true, data: { scores: parsed }, error: null });
  } catch (err) {
    console.error('[GET /cabinet/evidence-scores]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to fetch evidence scores' });
  }
});

// ─── GET /cabinet/redundancies ───────────────────────────────────────────────

router.get('/redundancies', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;

  // Return cached result if fresh
  const cached = redundancyCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    res.json({ success: true, data: { redundancies: cached.redundancies }, error: null });
    return;
  }

  try {
    const items = await CabinetItem.find({ userId: new Types.ObjectId(userId), active: true }).lean();

    if (items.length < 2) {
      res.json({ success: true, data: { redundancies: [] }, error: null });
      return;
    }

    const itemList = items.map((i) => ({
      name: i.name,
      type: i.type,
      dosage: i.dosage ?? null,
    }));

    const prompt = `You are a supplement safety expert. The user has the following active supplements/medications in their cabinet:

${JSON.stringify(itemList, null, 2)}

Identify any groups of items where the user is likely getting duplicate or excessive intake of the same nutrient. For each group you find, explain the overlap and what risk it poses.

IMPORTANT RULES:
- Only flag genuine overlaps you are highly confident about
- Do not speculate about vague possible overlaps
- If you see no clear redundancies, return an empty array

Return ONLY valid JSON (no markdown):
{
  "redundancies": [
    {
      "items": ["item name 1", "item name 2"],
      "nutrient": "nutrient name",
      "risk": "low|moderate|high",
      "explanation": "one to two sentences explaining the overlap",
      "recommendation": "one sentence on what to do"
    }
  ]
}`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let redundancies: RedundancyEntry[];
    try {
      const parsed = JSON.parse(cleaned) as { redundancies?: RedundancyEntry[] };
      redundancies = (parsed.redundancies ?? []).filter(
        (r) =>
          Array.isArray(r.items) &&
          r.items.length >= 2 &&
          typeof r.nutrient === 'string' &&
          ['low', 'moderate', 'high'].includes(r.risk) &&
          typeof r.explanation === 'string' &&
          typeof r.recommendation === 'string'
      );
    } catch {
      redundancies = [];
    }

    redundancyCache.set(userId, { redundancies, expiresAt: Date.now() + REDUNDANCY_TTL_MS });
    res.json({ success: true, data: { redundancies }, error: null });
  } catch (err) {
    console.error('[GET /cabinet/redundancies]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to analyse redundancies' });
  }
});


// POST /cabinet/first-insight — AI welcome insight for a new user's first supplement
router.post('/first-insight', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const { supplementName, userGoals } = req.body as { supplementName?: unknown; userGoals?: unknown };
    if (!supplementName || typeof supplementName !== 'string' || !supplementName.trim()) {
      res.status(400).json({ success: false, data: null, error: 'supplementName is required' });
      return;
    }

    const goalsText = Array.isArray(userGoals) && userGoals.length > 0
      ? `User goals: ${(userGoals as string[]).join(', ')}.`
      : '';

    const prompt = `You are a concise supplement advisor. ${goalsText}
Give a first-time user a brief, friendly insight about "${supplementName.trim()}".
Reply ONLY with valid JSON (no markdown fences):
{"uses":"<1-2 sentences on what it is commonly used for>","timing":"<1 sentence on best time to take it>","notes":"<1 sentence — most important practical note, e.g. take with food, avoid with caffeine>"}
Keep each value under 90 characters.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let data: { uses: string; timing: string; notes: string };
    try {
      const parsed = JSON.parse(cleaned) as { uses?: string; timing?: string; notes?: string };
      if (!parsed.uses || !parsed.timing || !parsed.notes) throw new Error('incomplete');
      data = { uses: parsed.uses, timing: parsed.timing, notes: parsed.notes };
    } catch {
      data = { uses: supplementName.trim(), timing: '', notes: '' };
    }

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=first-insight`);

    res.json({ success: true, data, error: null });
  } catch (err) {
    console.error('[POST /cabinet/first-insight]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to generate insight' });
  }
});


// ─── GET /cabinet/:id/research — deep-dive research panel ───────────────────

const DEEP_RESEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.get('/:id/research', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const itemId = String(req.params.id);
    if (!Types.ObjectId.isValid(itemId)) { res.status(400).json({ success: false, data: null, error: 'Invalid item id' }); return; }

    const userObjectId = new Types.ObjectId(userId);
    const forceRefresh = req.query.refresh === 'true';
    const cacheType = `deep-research:${itemId}`;

    const cached = await InsightCache.findOne({ userId: userObjectId, type: cacheType }).lean();
    const now = Date.now();
    const isFresh = cached && (now - cached.generatedAt.getTime()) < DEEP_RESEARCH_TTL_MS;

    if (isFresh && !forceRefresh) {
      let data: unknown;
      try { data = JSON.parse(cached.content); } catch { data = null; }
      res.json({ success: true, data: { research: data, generatedAt: cached.generatedAt.toISOString(), fromCache: true }, error: null });
      return;
    }

    if (forceRefresh && cached && isFresh) {
      const ageMs = now - cached.generatedAt.getTime();
      let data: unknown;
      try { data = JSON.parse(cached.content); } catch { data = null; }
      res.status(429).json({
        success: false,
        data: { research: data, generatedAt: cached.generatedAt.toISOString(), retryAfterMs: DEEP_RESEARCH_TTL_MS - ageMs },
        error: 'Research can only be refreshed once every 7 days per item',
      });
      return;
    }

    const [item, profile] = await Promise.all([
      CabinetItem.findOne({ _id: new Types.ObjectId(itemId), userId: userObjectId }).lean(),
      HealthProfile.findOne({ userId: userObjectId }).lean(),
    ]);

    if (!item) { res.status(404).json({ success: false, data: null, error: 'Item not found' }); return; }

    const goals = Array.isArray(profile?.goals?.primary) && profile.goals.primary.length > 0
      ? profile.goals.primary.join(', ')
      : 'general health and wellness';
    const currentDosage = item.dosage || 'not specified';

    const GRADE_MAP: Record<string, string> = {
      A: 'Grade A — strong evidence from multiple randomised controlled trials or systematic reviews',
      B: 'Grade B — moderate evidence from some RCTs or well-designed observational studies',
      C: 'Grade C — limited or mixed evidence; results are inconsistent across studies',
      D: 'Grade D — little to no human evidence; primarily anecdotal or preclinical research',
    };

    const prompt = `You are a research-based health advisor. Provide a detailed evidence summary for the following supplement.

Supplement: ${item.name}
Type: ${item.type}
User current dosage: ${currentDosage}
User health goals: ${goals}

Return ONLY valid JSON (no markdown fences):
{
  "grade": "A|B|C|D",
  "gradeExplanation": "<one sentence explaining why this grade — cite study type e.g. RCT, meta-analysis>",
  "findings": ["<finding 1 related to user goals>", "<finding 2>", "<finding 3>"],
  "dosageRange": "<evidence-supported dosage range e.g. 300–600mg daily>",
  "dosageComparison": "<one sentence comparing user dose to evidence range — or null if user dose not specified>",
  "citations": ["<url 1>", "<url 2>"]
}

Rules:
- Keep each finding to 1 sentence, make it specific and data-driven
- Citations must be real examine.com or pubmed.ncbi.nlm.nih.gov URLs
- If you are not confident about a citation URL, omit it rather than fabricate it
- This is informational only, not personalised medical advice`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^[\`]{0,3}(?:json)?\s*/i, '').replace(/\s*[\`]{0,3}$/, '').trim();

    let research: {
      grade: string;
      gradeExplanation: string;
      findings: string[];
      dosageRange: string;
      dosageComparison: string | null;
      citations: string[];
    };

    try {
      const parsed = JSON.parse(cleaned) as typeof research;
      research = {
        grade: ['A','B','C','D'].includes(parsed.grade) ? parsed.grade : 'C',
        gradeExplanation: parsed.gradeExplanation || GRADE_MAP[parsed.grade] || '',
        findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 3) : [],
        dosageRange: parsed.dosageRange || '',
        dosageComparison: parsed.dosageComparison || null,
        citations: Array.isArray(parsed.citations) ? parsed.citations.filter((u: unknown) => typeof u === 'string').slice(0, 2) : [],
      };
    } catch {
      research = { grade: 'C', gradeExplanation: GRADE_MAP['C'], findings: [], dosageRange: '', dosageComparison: null, citations: [] };
    }

    const generatedAt = new Date();
    await InsightCache.findOneAndUpdate(
      { userId: userObjectId, type: cacheType },
      { content: JSON.stringify(research), generatedAt },
      { upsert: true, new: true }
    );

    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=deep-research item=${item.name}`);

    res.json({ success: true, data: { research, generatedAt: generatedAt.toISOString(), fromCache: false }, error: null });
  } catch (err) {
    console.error('[GET /cabinet/:id/research]', err);
    res.status(500).json({ success: false, data: null, error: 'Failed to generate research' });
  }
});

export default router;
