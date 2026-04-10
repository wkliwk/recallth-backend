import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { HealthProfile, IChangeEntry } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';
import { MODELS } from '../config/models';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

const router = Router();

// All routes in this file are protected — authenticate is applied at mount time
// in index.ts, so we re-declare it here only for the inline router usage.
// The router itself is exported and mounted with authenticate already applied.

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Flatten a nested object into dot-notation keys.
 * e.g. { body: { height: 180 } } → { 'body.height': 180 }
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, unknown> {
  return Object.entries(obj).reduce<Record<string, unknown>>((acc, [key, value]) => {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      Object.assign(acc, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      acc[fullKey] = value;
    }
    return acc;
  }, {});
}

/**
 * Build a set of IChangeEntry items by comparing old flat values with new flat values.
 */
function buildChangeEntries(
  oldFlat: Record<string, unknown>,
  newFlat: Record<string, unknown>
): IChangeEntry[] {
  const now = new Date();
  const entries: IChangeEntry[] = [];

  for (const [field, newValue] of Object.entries(newFlat)) {
    const oldValue = oldFlat[field] ?? null;
    const serialisedOld = JSON.stringify(oldValue);
    const serialisedNew = JSON.stringify(newValue);
    if (serialisedOld !== serialisedNew) {
      entries.push({ field, oldValue, newValue, source: 'user_input', timestamp: now });
    }
  }

  return entries;
}

// ─── GET /profile ──────────────────────────────────────────────────────────

router.get('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  const profile = await HealthProfile.findOne({ userId });

  if (!profile) {
    // Return an empty profile shell — new user, no data yet
    res.json({
      success: true,
      data: {
        userId,
        body: {},
        diet: {},
        exercise: {},
        sleep: {},
        lifestyle: {},
        goals: {},
        changeHistory: [],
      },
      error: null,
    });
    return;
  }

  res.json({ success: true, data: profile, error: null });
});

// ─── PUT /profile ──────────────────────────────────────────────────────────

router.put('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  // Only accept recognised top-level category keys
  const ALLOWED_CATEGORIES = ['body', 'diet', 'exercise', 'sleep', 'lifestyle', 'goals'] as const;
  type Category = typeof ALLOWED_CATEGORIES[number];

  const incoming = req.body as Partial<Record<Category, Record<string, unknown>>>;

  // Validate: only known categories accepted
  const unknownKeys = Object.keys(incoming).filter(
    (k) => !ALLOWED_CATEGORIES.includes(k as Category)
  );
  if (unknownKeys.length > 0) {
    res.status(400).json({
      success: false,
      data: null,
      error: `Unknown fields: ${unknownKeys.join(', ')}`,
    });
    return;
  }

  // Load or initialise the profile
  let profile = await HealthProfile.findOne({ userId });
  const isNew = !profile;

  if (!profile) {
    profile = new HealthProfile({ userId });
  }

  // Capture old flat values for change tracking
  const oldFlat = flattenObject(
    ALLOWED_CATEGORIES.reduce<Record<string, unknown>>((acc, cat) => {
      const val = (profile as unknown as Record<string, unknown>)[cat];
      if (val && typeof val === 'object') {
        acc[cat] = (val as { toObject?: () => unknown }).toObject
          ? (val as { toObject: () => unknown }).toObject()
          : val;
      } else {
        acc[cat] = {};
      }
      return acc;
    }, {})
  );

  // Apply partial updates using dot-notation $set to avoid overwriting sibling fields
  const setPayload: Record<string, unknown> = {};

  for (const cat of ALLOWED_CATEGORIES) {
    if (!(cat in incoming)) continue;
    const categoryData = incoming[cat];
    if (typeof categoryData !== 'object' || categoryData === null || Array.isArray(categoryData)) {
      res.status(400).json({
        success: false,
        data: null,
        error: `Field '${cat}' must be an object`,
      });
      return;
    }
    for (const [field, value] of Object.entries(categoryData)) {
      setPayload[`${cat}.${field}`] = value;
    }
  }

  // Build new flat snapshot for change detection
  // Merge incoming fields onto the captured old values
  const mergedFlat: Record<string, unknown> = { ...oldFlat };
  for (const [dotKey, value] of Object.entries(setPayload)) {
    mergedFlat[dotKey] = value;
  }

  const newEntries = isNew
    ? buildChangeEntries({}, mergedFlat)
    : buildChangeEntries(oldFlat, mergedFlat);

  // Persist using findOneAndUpdate with $set + $push for history
  const updateOp: Record<string, unknown> = { $set: setPayload };
  if (newEntries.length > 0) {
    updateOp['$push'] = { changeHistory: { $each: newEntries } };
  }

  const updated = await HealthProfile.findOneAndUpdate(
    { userId },
    updateOp,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json({ success: true, data: updated, error: null });
});

// ─── GET /profile/weight-trend ─────────────────────────────────────────────

router.get('/weight-trend', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  const profile = await HealthProfile.findOne({ userId }, { changeHistory: 1, 'body.weight': 1 }).lean();

  if (!profile) {
    res.json({ success: true, data: { entries: [] }, error: null });
    return;
  }

  // Filter changeHistory for weight entries
  const weightEntries = (profile.changeHistory ?? [])
    .filter((entry) => entry.field === 'body.weight' && entry.newValue !== null && entry.newValue !== undefined)
    .map((entry) => ({
      timestamp: entry.timestamp,
      value: entry.newValue as number,
      source: entry.source,
    }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  res.json({ success: true, data: { entries: weightEntries }, error: null });
});

// ─── GET /profile/export-report ───────────────────────────────────────────────

router.get('/export-report', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = new Types.ObjectId(req.userId);

  try {
    const [profile, cabinetItems] = await Promise.all([
      HealthProfile.findOne({ userId }).lean(),
      CabinetItem.find({ userId, active: true }).lean(),
    ]);

    const profileData = profile
      ? { body: profile.body, diet: profile.diet, exercise: profile.exercise, sleep: profile.sleep, lifestyle: profile.lifestyle, goals: profile.goals }
      : null;

    const cabinetData = cabinetItems.map((i) => ({
      name: i.name,
      type: i.type,
      dosage: i.dosage,
      frequency: i.frequency,
      timing: i.timing,
      brand: i.brand,
    }));

    const prompt = `You are a health record summariser. Write a concise, professional health summary report based on the user's data below. This report is intended to be shared with a doctor, nutritionist, or other healthcare professional.

USER HEALTH PROFILE:
${JSON.stringify(profileData, null, 2)}

SUPPLEMENT & MEDICATION CABINET:
${JSON.stringify(cabinetData, null, 2)}

Write the report in plain text (no markdown). Include these sections:
1. PERSONAL STATISTICS — height, weight, age, sex, body composition goals
2. DIET & NUTRITION — diet type, restrictions, allergies
3. EXERCISE — type, frequency, intensity, goals
4. SLEEP — schedule, quality, issues
5. LIFESTYLE — stress, alcohol, smoking
6. HEALTH GOALS — primary goals
7. CURRENT SUPPLEMENT & MEDICATION STACK — list each item with dosage/frequency/timing
8. NOTES — any AI observations about the profile (gaps, consistency, etc.)

If a section has no data, write "No information provided."
Start with: "HEALTH SUMMARY REPORT" and include the date: ${new Date().toDateString()}
End with a disclaimer: "This report is informational only and does not constitute medical advice."`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const report = result.response.text().trim();

    res.json({
      success: true,
      error: null,
      data: {
        report,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[GET /profile/export-report]', err);
    res.status(500).json({ success: false, error: 'Failed to generate report', data: null });
  }
});

export default router;
