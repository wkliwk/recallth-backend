import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { FoodItem, computeNutritionFlags } from '../models/FoodItem';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

/** Scrape og:image from a page URL. Returns null if not found or invalid. */
async function scrapeImage(pageUrl: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(pageUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();

    let candidate: string | null = null;
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (og?.[1]) candidate = og[1];
    if (!candidate) {
      const tw = html.match(/<meta[^>]+(?:name|property)=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
      if (tw?.[1]) candidate = tw[1];
    }
    if (!candidate) return null;
    if (candidate.startsWith('//')) candidate = `https:${candidate}`;
    candidate = candidate.replace(/^http:\/\//, 'https://');

    // Validate: check first bytes are an image
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 4000);
    const val = await fetch(candidate, {
      method: 'GET',
      signal: ctrl2.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/*',
        'Referer': new URL(candidate).origin + '/',
        'Range': 'bytes=0-3',
      },
      redirect: 'follow',
    });
    clearTimeout(t2);
    const ct = val.headers.get('content-type') || '';
    if (val.ok || val.status === 206) {
      if (ct.startsWith('image/')) return candidate;
      const buf = Buffer.from(await val.arrayBuffer());
      const isImg = (buf[0] === 0xFF && buf[1] === 0xD8) // JPEG
        || (buf[0] === 0x89 && buf[1] === 0x50)           // PNG
        || (buf[0] === 0x52 && buf[1] === 0x49)           // RIFF/WebP
        || (buf[0] === 0x47 && buf[1] === 0x49);          // GIF
      if (isImg) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

const router = Router();

// All admin routes require adminAuth
router.use(adminAuth);

// ─── GET /admin/food-db — list with pagination + filters ─────────────────────

router.get('/food-db', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { q, category, status, page: pageStr, limit: limitStr } = req.query as Record<string, string>;

    const page = Math.max(parseInt(pageStr ?? '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);
    const skip = (page - 1) * limit;

    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (status) filter.status = status;
    else filter.status = { $ne: 'merged' }; // exclude merged by default
    if (q) {
      const re = new RegExp(q, 'i');
      filter.$or = [{ name: re }, { displayName: re }, { aliases: re }];
    }

    const [items, total] = await Promise.all([
      FoodItem.find(filter).sort({ logCount: -1, displayName: 1 }).skip(skip).limit(limit).lean(),
      FoodItem.countDocuments(filter),
    ]);

    res.json({ success: true, data: items, total, page, limit });
  } catch (err) {
    console.error('[GET /admin/food-db]', err);
    res.status(500).json({ success: false, error: 'Failed to list food items' });
  }
});

// ─── GET /admin/food-db/:id — single item ────────────────────────────────────

router.get('/food-db/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }
    const item = await FoodItem.findById(id).lean();
    if (!item) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, data: item });
  } catch (err) {
    console.error('[GET /admin/food-db/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to get food item' });
  }
});

// ─── POST /admin/food-db — create ────────────────────────────────────────────

router.post('/food-db', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = req.body;
    const per100g = body.per100g;
    const servingGrams = Number(body.defaultServingGrams) || 100;

    const item = await FoodItem.create({
      ...body,
      defaultServingGrams: servingGrams,
      nutritionFlags: computeNutritionFlags(per100g, servingGrams),
    });

    res.status(201).json({ success: true, data: item });
  } catch (err: unknown) {
    console.error('[POST /admin/food-db]', err);
    const msg = err instanceof Error ? err.message : 'Failed to create food item';
    res.status(400).json({ success: false, error: msg });
  }
});

// ─── PUT /admin/food-db/:id — update ─────────────────────────────────────────

router.put('/food-db/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }

    const body = req.body;
    const per100g = body.per100g;
    const servingGrams = Number(body.defaultServingGrams) || 100;

    const updated = await FoodItem.findByIdAndUpdate(
      id,
      {
        ...body,
        defaultServingGrams: servingGrams,
        nutritionFlags: per100g ? computeNutritionFlags(per100g, servingGrams) : undefined,
      },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err: unknown) {
    console.error('[PUT /admin/food-db/:id]', err);
    const msg = err instanceof Error ? err.message : 'Failed to update food item';
    res.status(400).json({ success: false, error: msg });
  }
});

// ─── DELETE /admin/food-db/:id — soft delete (status → deprecated) ───────────

router.delete('/food-db/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }

    const updated = await FoodItem.findByIdAndUpdate(
      id,
      { status: 'deprecated' },
      { new: true }
    ).lean();

    if (!updated) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[DELETE /admin/food-db/:id]', err);
    res.status(500).json({ success: false, error: 'Failed to delete food item' });
  }
});

// ─── POST /admin/food-db/:id/grab-image — auto-fetch dish image ──────────────

router.post('/food-db/:id/grab-image', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }
    const item = await FoodItem.findById(id).lean();
    if (!item) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }

    const searchQuery = [item.displayName, item.name, item.brand].filter(Boolean).join(' ');

    // Use Gemini with Google Search grounding to find relevant pages
    const model = getGenAI().getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools: [{ googleSearch: {} } as any],
    });
    const result = await model.generateContent(
      `Find a good food photo or product image for: "${searchQuery}". This is a food item.`
    );

    const groundingMeta = (result.response.candidates?.[0] as any)?.groundingMetadata;
    const chunks: { web?: { uri?: string } }[] = groundingMeta?.groundingChunks || [];
    const pageUrls = chunks
      .map((c) => c.web?.uri)
      .filter((u): u is string => !!u && u.startsWith('http'))
      .slice(0, 5);

    let imageUrl: string | null = null;
    for (const url of pageUrls) {
      imageUrl = await scrapeImage(url);
      if (imageUrl) break;
    }

    if (!imageUrl) {
      res.status(422).json({ success: false, error: 'No image found' });
      return;
    }

    await FoodItem.findByIdAndUpdate(id, { dishImageUrl: imageUrl });

    res.json({ success: true, data: { dishImageUrl: imageUrl } });
  } catch (err) {
    console.error('[POST /admin/food-db/:id/grab-image]', err);
    res.status(500).json({ success: false, error: 'Failed to grab image' });
  }
});

export default router;
