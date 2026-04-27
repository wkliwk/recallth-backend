import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { BloodworkEntry } from '../models/BloodworkEntry';
import { CabinetItem } from '../models/CabinetItem';
import { HealthProfile } from '../models/HealthProfile';
import { InsightCache } from '../models/InsightCache';
import { MODELS } from '../config/models';
import { buildAiUsage } from '../utils/aiUsage';

const router = Router();

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

// POST /bloodwork — create a new bloodwork entry
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { date, marker, value, unit, refLow, refHigh } = req.body as {
      date: unknown;
      marker: unknown;
      value: unknown;
      unit: unknown;
      refLow?: unknown;
      refHigh?: unknown;
    };

    if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
      res.status(400).json({ error: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    if (typeof marker !== 'string' || marker.trim().length === 0) {
      res.status(400).json({ error: 'marker must be a non-empty string' });
      return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      res.status(400).json({ error: 'value must be a number' });
      return;
    }

    if (typeof unit !== 'string' || unit.trim().length === 0) {
      res.status(400).json({ error: 'unit must be a non-empty string' });
      return;
    }

    const parsedRefLow = typeof refLow === 'number' && Number.isFinite(refLow) ? refLow : undefined;
    const parsedRefHigh = typeof refHigh === 'number' && Number.isFinite(refHigh) ? refHigh : undefined;

    const entry = await BloodworkEntry.create({
      userId: req.userId,
      date,
      marker: marker.trim(),
      value,
      unit: unit.trim(),
      ...(parsedRefLow !== undefined && { refLow: parsedRefLow }),
      ...(parsedRefHigh !== undefined && { refHigh: parsedRefHigh }),
    });

    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    console.error('Bloodwork POST error:', error);
    res.status(500).json({ error: 'Failed to save bloodwork entry' });
  }
});

// GET /bloodwork — list all entries for the user, optionally filtered by marker
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const filter: { userId: string | undefined; marker?: string } = { userId: req.userId };

    if (typeof req.query.marker === 'string' && req.query.marker.length > 0) {
      filter.marker = req.query.marker;
    }

    const entries = await BloodworkEntry.find(filter).sort({ date: 1 });

    res.json({ success: true, data: entries });
  } catch (error) {
    console.error('Bloodwork GET error:', error);
    res.status(500).json({ error: 'Failed to retrieve bloodwork entries' });
  }
});

// PUT /bloodwork/:id — update an existing bloodwork entry
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({ success: false, error: 'Entry not found' });
      return;
    }

    const { date, marker, value, unit, refLow, refHigh } = req.body as {
      date: unknown;
      marker: unknown;
      value: unknown;
      unit: unknown;
      refLow?: unknown;
      refHigh?: unknown;
    };

    if (typeof date !== 'string' || !DATE_REGEX.test(date)) {
      res.status(400).json({ error: 'date must be a valid YYYY-MM-DD string' });
      return;
    }

    if (typeof marker !== 'string' || marker.trim().length === 0) {
      res.status(400).json({ error: 'marker must be a non-empty string' });
      return;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      res.status(400).json({ error: 'value must be a number' });
      return;
    }

    if (typeof unit !== 'string' || unit.trim().length === 0) {
      res.status(400).json({ error: 'unit must be a non-empty string' });
      return;
    }

    const parsedRefLow = typeof refLow === 'number' && Number.isFinite(refLow) ? refLow : null;
    const parsedRefHigh = typeof refHigh === 'number' && Number.isFinite(refHigh) ? refHigh : null;

    const entry = await BloodworkEntry.findOneAndUpdate(
      { _id: id, userId: req.userId },
      { date, marker: marker.trim(), value, unit: unit.trim(), refLow: parsedRefLow, refHigh: parsedRefHigh },
      { new: true }
    );

    if (!entry) {
      res.status(404).json({ success: false, error: 'Entry not found' });
      return;
    }

    res.json({ success: true, data: entry });
  } catch (error) {
    console.error('Bloodwork PUT error:', error);
    res.status(500).json({ error: 'Failed to update bloodwork entry' });
  }
});

// POST /bloodwork/analyse — AI interpretation of latest bloodwork results
router.post('/analyse', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    const userObjectId = new Types.ObjectId(userId);

    const [entries, cabinetItems, profile] = await Promise.all([
      BloodworkEntry.find({ userId: userObjectId }).sort({ date: -1 }).lean(),
      CabinetItem.find({ userId: userObjectId, active: true }).lean(),
      HealthProfile.findOne({ userId: userObjectId }).lean(),
    ]);

    if (entries.length === 0) {
      res.status(400).json({ success: false, data: null, error: 'No bloodwork entries found' });
      return;
    }

    // Use latest entry per marker
    const latestPerMarker = new Map<string, typeof entries[0]>();
    for (const entry of entries) {
      if (!latestPerMarker.has(entry.marker)) {
        latestPerMarker.set(entry.marker, entry);
      }
    }

    const bloodworkSummary = [...latestPerMarker.values()]
      .map((e) => `- ${e.marker}: ${e.value} ${e.unit} (measured ${e.date})`)
      .join('\n');

    const supplementList = cabinetItems.length > 0
      ? cabinetItems.map((i) => {
          const parts = [i.name];
          if (i.dosage) parts.push(`dosage: ${i.dosage}`);
          if (i.frequency) parts.push(`frequency: ${i.frequency}`);
          return `- ${parts.join(', ')}`;
        }).join('\n')
      : 'No active supplements or medications.';

    const goals = profile?.goals?.primary?.join(', ') || 'Not specified';

    const prompt = `You are an evidence-based health advisor reviewing a user's bloodwork results.

Latest bloodwork values:
${bloodworkSummary}

Currently taking:
${supplementList}

Health goals: ${goals}

Analyse these results and return a JSON object with this exact shape:
{
  "markersOfNote": [
    {
      "marker": "<marker name>",
      "value": <number>,
      "unit": "<unit>",
      "status": "low" | "high" | "borderline",
      "explanation": "<plain English: what this marker measures and why this value matters>",
      "recommendation": "<specific, evidence-based action suggestion>"
    }
  ],
  "supplementAdjustments": [
    {
      "name": "<supplement or nutrient name>",
      "action": "add" | "increase" | "decrease" | "remove" | "maintain",
      "reason": "<brief explanation based on bloodwork values>"
    }
  ],
  "whatToWatch": [
    "<marker or test to recheck at next appointment>"
  ]
}

Rules:
- Only include markers that are genuinely outside a healthy reference range or borderline. If all markers look healthy, return an empty markersOfNote array.
- Keep explanations plain and non-alarmist.
- Only suggest supplement changes that are directly supported by the bloodwork data.
- Return at most 3 items in whatToWatch.
- Return ONLY valid JSON — no markdown fences, no extra text.
- This is general health information, not personalised medical advice.`;

    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(
      `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=bloodwork-analyse`
    );
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

    const text = result.response.text().trim();
    const cleaned = text.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '').trim();

    let parsed: {
      markersOfNote: Array<{ marker: string; value: number; unit: string; status: string; explanation: string; recommendation: string }>;
      supplementAdjustments: Array<{ name: string; action: string; reason: string }>;
      whatToWatch: string[];
    };
    try {
      parsed = JSON.parse(cleaned) as typeof parsed;
    } catch {
      res.status(422).json({ success: false, data: null, error: 'Could not parse AI response' });
      return;
    }

    res.json({
      success: true,
      data: {
        markersOfNote: parsed.markersOfNote ?? [],
        supplementAdjustments: parsed.supplementAdjustments ?? [],
        whatToWatch: parsed.whatToWatch ?? [],
        generatedAt: new Date().toISOString(),
        aiUsage,
      },
      error: null,
    });
  } catch (err) {
    console.error('[POST /bloodwork/analyse]', err);
    res.status(500).json({ success: false, data: null, error: 'Bloodwork analysis failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /bloodwork/interpret — personalised AI interpretation with 24h cache
// ---------------------------------------------------------------------------
const INTERPRET_CACHE_TYPE = 'bloodwork-interpret-v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface BloodworkInterpretation {
  marker: string;
  latestValue: number;
  unit: string;
  status: 'above_range' | 'below_range' | 'in_range';
  summary: string;
  personalised_insight: string;
  recommendation: string;
  supplement_link: string[];
  priority: 'high' | 'medium' | 'low';
}

interface InterpretResponse {
  interpretations: BloodworkInterpretation[];
  overall_summary: string;
  generated_at: string;
}

router.post('/interpret', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, data: null, error: 'Unauthorized' }); return; }

    // Check cache (24h TTL)
    const cached = await InsightCache.findOne({ userId, type: INTERPRET_CACHE_TYPE });
    if (cached) {
      const age = Date.now() - cached.generatedAt.getTime();
      if (age < CACHE_TTL_MS) {
        const parsed = JSON.parse(cached.content) as InterpretResponse;
        res.json({ success: true, data: parsed, error: null });
        return;
      }
    }

    // Gather data in parallel
    const [allEntries, profile, cabinetItems] = await Promise.all([
      BloodworkEntry.find({ userId }).sort({ date: 1, createdAt: 1 }).lean(),
      HealthProfile.findOne({ userId }).lean(),
      CabinetItem.find({ userId, active: true }).lean(),
    ]);

    // Return empty if no bloodwork logged
    if (allEntries.length === 0) {
      const empty: InterpretResponse = { interpretations: [], overall_summary: '', generated_at: new Date().toISOString() };
      res.json({ success: true, data: empty, error: null });
      return;
    }

    // Build per-marker timeline (latest value + all historical values for trend)
    const markerMap = new Map<string, { latest: typeof allEntries[0]; values: number[] }>();
    for (const e of allEntries) {
      const entry = markerMap.get(e.marker);
      if (!entry) {
        markerMap.set(e.marker, { latest: e, values: [e.value] });
      } else {
        entry.latest = e;
        entry.values.push(e.value);
      }
    }

    const bloodworkLines = [...markerMap.entries()]
      .map(([marker, { latest, values }]) => {
        const trend = values.length > 1
          ? (values[values.length - 1] > values[0] ? '↑ trending up' : values[values.length - 1] < values[0] ? '↓ trending down' : '→ stable')
          : '';
        const refRange = (latest.refLow != null && latest.refHigh != null)
          ? ` [user lab reference: ${latest.refLow}–${latest.refHigh} ${latest.unit}]`
          : (latest.refLow != null ? ` [user lab reference low: ${latest.refLow} ${latest.unit}]`
          : latest.refHigh != null ? ` [user lab reference high: ${latest.refHigh} ${latest.unit}]`
          : '');
        return `- ${marker}: ${latest.value} ${latest.unit} (measured ${latest.date})${trend ? ' ' + trend : ''}${refRange}`;
      })
      .join('\n');

    const supplementLines = cabinetItems.length > 0
      ? cabinetItems.map((i) => `- ${i.name}${i.dosage ? ` ${i.dosage}` : ''}${i.timing ? ` (${i.timing})` : ''}`).join('\n')
      : 'None';

    const body = profile?.body;
    const goals = (profile?.goals?.primary ?? []).join(', ') || 'general wellness';
    const profileSnippet = [
      body?.age ? `Age: ${body.age}` : null,
      body?.sex ? `Sex: ${body.sex}` : null,
      body?.weight ? `Weight: ${body.weight} kg` : null,
      profile?.exercise?.type?.length ? `Exercise: ${profile.exercise.type.join(', ')}` : null,
    ].filter(Boolean).join(', ') || 'Not provided';

    const prompt = `You are an evidence-based health advisor interpreting bloodwork results for a user.

## User profile
${profileSnippet}
Health goals: ${goals}

## Active supplements / medications
${supplementLines}

## Latest bloodwork values
${bloodworkLines}

Return ONLY valid JSON (no markdown) in this exact shape:
{
  "interpretations": [
    {
      "marker": "string — exact marker name from the data",
      "latestValue": number,
      "unit": "string",
      "status": "above_range" | "below_range" | "in_range",
      "summary": "1-sentence plain-language explanation of what this value means",
      "personalised_insight": "1-2 sentences referencing this user's specific goals or supplements",
      "recommendation": "specific, evidence-based action — dosage and timing where relevant",
      "supplement_link": ["supplement names already in cabinet or suggested additions"],
      "priority": "high" | "medium" | "low"
    }
  ],
  "overall_summary": "1-2 sentence overview of the full panel — highlight biggest gaps. End with: Not medical advice."
}

Rules:
- Include ALL markers. Even in-range markers should have an entry (status: in_range, priority: low).
- Personalise every personalised_insight — reference specific supplements, goals, or profile details.
- supplement_link should list existing cabinet items that address this marker, or suggest additions.
- priority: high if significantly out of range, medium if borderline, low if in range.
- Be specific about dosages in recommendations where clinically relevant.
- When a marker has a "[user lab reference: X–Y]" annotation, ALWAYS use those bounds to determine status (above/below/in_range). Mention "Based on your lab's reference range of X–Y" in personalised_insight.
- When no user range is provided, use standard clinical reference ranges.
- Return only valid JSON — no markdown, no explanation outside the JSON.`;

    const aiModel = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await aiModel.generateContent(prompt);
    const usage = result.response.usageMetadata;
    console.log(`[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=bloodwork-interpret`);
    const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

    let raw = result.response.text().trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();

    const parsed = JSON.parse(raw) as InterpretResponse;
    parsed.generated_at = new Date().toISOString();

    // Cache the result
    const content = JSON.stringify(parsed);
    await InsightCache.findOneAndUpdate(
      { userId, type: INTERPRET_CACHE_TYPE },
      { userId, type: INTERPRET_CACHE_TYPE, content, generatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ success: true, data: { ...parsed, aiUsage }, error: null });
  } catch (err) {
    console.error('[POST /bloodwork/interpret]', err);
    res.status(500).json({ success: false, data: null, error: 'Bloodwork interpretation failed' });
  }
});

export { router as bloodworkRouter };
