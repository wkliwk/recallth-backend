import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { FoodItem, computeNutritionFlags } from '../models/FoodItem';
import { MODELS } from '../config/models';

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

// ─── DELETE /admin/food-db/:id/hard — permanent delete ───────────────────────

router.delete('/food-db/:id/hard', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, error: 'Invalid ID' });
      return;
    }
    const deleted = await FoodItem.findByIdAndDelete(id).lean();
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /admin/food-db/:id/hard]', err);
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// ─── POST /admin/food-db/url-lookup — populate food item from URL ────────────

router.post('/food-db/url-lookup', async (req: AuthRequest, res: Response): Promise<void> => {
  const { url } = req.body as { url?: string };

  if (!url || typeof url !== 'string' || !/^https?:\/\/.+/.test(url.trim())) {
    res.status(400).json({ success: false, error: 'A valid http/https URL is required' });
    return;
  }

  try {
    // Fetch page HTML
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let html = '';
    try {
      const pageRes = await fetch(url.trim(), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,zh;q=0.8',
        },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!pageRes.ok) {
        res.status(422).json({ success: false, error: `Could not fetch URL (${pageRes.status})` });
        return;
      }
      html = await pageRes.text();
    } catch {
      clearTimeout(timer);
      res.status(422).json({ success: false, error: 'Could not reach URL' });
      return;
    }

    // Extract signals
    const getMeta = (pattern: RegExp) => html.match(pattern)?.[1]?.trim() ?? '';
    const ogTitle   = getMeta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
                   || getMeta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const ogDesc    = getMeta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
                   || getMeta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
    const ogImage   = getMeta(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || getMeta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const metaDesc  = getMeta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const pageTitle = getMeta(/<title[^>]*>([^<]+)<\/title>/i);

    // JSON-LD blocks (NutritionInformation or Product)
    const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
    let ldData = '';
    for (const block of ldBlocks) {
      const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
      if (inner.includes('Nutrition') || inner.includes('Product') || inner.includes('nutrition')) {
        ldData = inner.slice(0, 3000);
        break;
      }
    }

    const visibleText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 3000);

    const pageSignals = [
      ogTitle    && `og:title: ${ogTitle}`,
      ogDesc     && `og:description: ${ogDesc}`,
      metaDesc   && `meta description: ${metaDesc}`,
      pageTitle  && `page title: ${pageTitle}`,
      ldData     && `JSON-LD: ${ldData}`,
      `Visible text: ${visibleText}`,
    ].filter(Boolean).join('\n');

    const CATEGORIES = ['rice_noodles','protein','dim_sum','soup','bread_pastry','drinks','desserts','snacks','fast_food','whole_food','packaged'];

    const prompt = `You are a food nutritionist and database expert. Extract food item data from this web page.

URL: ${url.trim()}

Page content:
${pageSignals}

Return ONLY a valid JSON object (no markdown fences):
{
  "name": string,               // internal name (lowercase English, e.g. "oat milk")
  "displayName": string,        // display name (proper case, may include Chinese, e.g. "Oat Milk 燕麥奶")
  "brand": string | null,
  "category": one of ${JSON.stringify(CATEGORIES)},
  "per100g": {
    "calories": number,         // kcal per 100g
    "protein": number,          // g per 100g
    "carbs": number,            // g per 100g
    "fat": number,              // g per 100g
    "sugar": number | null,
    "fiber": number | null,
    "sodium": number | null     // mg per 100g
  },
  "defaultServingGrams": number,   // typical single serving in grams
  "defaultServingUnit": string,    // e.g. "g", "ml", "piece", "cup"
  "source": "official" | "openfoodfacts" | "community" | "reference" | "ai_estimated",
  "dataSourceUrl": string | null,  // the source URL if it's a reputable nutrition source
  "notes": string | null
}

Rules:
- All nutrition values must be PER 100g (convert if the page shows per-serving values)
- If you cannot find reliable nutrition data, return { "error": "No nutrition data found" }
- Choose source based on URL domain: openfoodfacts.org → "openfoodfacts", official brand/govt → "official", else → "ai_estimated"`;

    const parseJson = (raw: string): Record<string, unknown> | null => {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      try { return JSON.parse(cleaned); } catch { return null; }
    };

    // Attempt 1: raw HTML context
    const model = getGenAI().getGenerativeModel({ model: MODELS.CHAT });
    const result = await model.generateContent(prompt);
    let data = parseJson(result.response.text());

    // Attempt 2: Google Search grounding (fallback for JS-rendered pages)
    if (!data || data.error) {
      const productHint = ogTitle || pageTitle || url.trim();
      const groundingPrompt = `Find the complete nutrition facts for this food product and return them as structured JSON.

Product URL: ${url.trim()}
Product name hint: ${productHint}

Search for the official nutrition information (per 100g or per 100ml). Convert any per-serving values to per-100g.

Return ONLY a valid JSON object (no markdown fences):
{
  "name": string,
  "displayName": string,
  "brand": string | null,
  "category": one of ${JSON.stringify(CATEGORIES)},
  "per100g": {
    "calories": number,
    "protein": number,
    "carbs": number,
    "fat": number,
    "sugar": number | null,
    "fiber": number | null,
    "sodium": number | null
  },
  "defaultServingGrams": number,
  "defaultServingUnit": string,
  "source": "official" | "openfoodfacts" | "community" | "reference" | "ai_estimated",
  "dataSourceUrl": string | null,
  "notes": string | null
}

If you cannot find reliable nutrition data, return { "error": "No nutrition data found" }`;

      const groundingModel = getGenAI().getGenerativeModel({
        model: MODELS.CHAT,
        tools: [{ googleSearch: {} } as any],
      });
      const groundingResult = await groundingModel.generateContent(groundingPrompt);
      data = parseJson(groundingResult.response.text()) ?? { error: 'No nutrition data found' };
    }

    if (!data || data.error) {
      res.status(422).json({ success: false, error: (data?.error as string) ?? 'No nutrition data found' });
      return;
    }

    // Attach og:image if found
    if (ogImage && !data.dishImageUrl) {
      let imgUrl = ogImage.startsWith('//') ? `https:${ogImage}` : ogImage;
      imgUrl = imgUrl.replace(/^http:\/\//, 'https://');
      data.dishImageUrl = imgUrl;
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('[POST /admin/food-db/url-lookup]', err);
    res.status(500).json({ success: false, error: 'URL lookup failed' });
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
      model: MODELS.CHAT,
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

// ─── POST /admin/food-db/grab-missing-images — batch grab for items without dishImageUrl ──

router.post('/food-db/grab-missing-images', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const items = await FoodItem.find({ dishImageUrl: { $exists: false }, status: { $ne: 'deprecated' } }, '_id displayName name brand').lean();

    if (items.length === 0) {
      res.json({ success: true, data: { processed: 0, succeeded: 0, failed: 0 } });
      return;
    }

    let succeeded = 0;
    let failed = 0;
    const errors: { id: string; name: string; error: string }[] = [];

    const model = getGenAI().getGenerativeModel({
      model: MODELS.CHAT,
      tools: [{ googleSearch: {} } as any],
    });

    for (const item of items) {
      try {
        const searchQuery = [item.displayName, item.name, item.brand].filter(Boolean).join(' ');
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

        if (imageUrl) {
          await FoodItem.findByIdAndUpdate(item._id, { dishImageUrl: imageUrl });
          succeeded++;
        } else {
          failed++;
          errors.push({ id: String(item._id), name: item.displayName || item.name, error: 'No image found' });
        }
      } catch (err) {
        failed++;
        errors.push({ id: String(item._id), name: item.displayName || item.name, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    res.json({ success: true, data: { processed: items.length, succeeded, failed, errors } });
  } catch (err) {
    console.error('[POST /admin/food-db/grab-missing-images]', err);
    res.status(500).json({ success: false, error: 'Batch grab-image failed' });
  }
});

export default router;
