import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { authenticate, AuthRequest } from '../middleware/auth';
import { BloodworkEntry } from '../models/BloodworkEntry';
import { CabinetItem } from '../models/CabinetItem';
import { HealthProfile } from '../models/HealthProfile';
import { MODELS } from '../config/models';

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
    const { date, marker, value, unit } = req.body as {
      date: unknown;
      marker: unknown;
      value: unknown;
      unit: unknown;
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

    const entry = await BloodworkEntry.create({
      userId: req.userId,
      date,
      marker: marker.trim(),
      value,
      unit: unit.trim(),
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
      },
      error: null,
    });
  } catch (err) {
    console.error('[POST /bloodwork/analyse]', err);
    res.status(500).json({ success: false, data: null, error: 'Bloodwork analysis failed' });
  }
});

export { router as bloodworkRouter };
