import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { HealthProfile, IChangeEntry } from '../models/HealthProfile';

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

export default router;
