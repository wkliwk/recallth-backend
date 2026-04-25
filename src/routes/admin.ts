import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { FoodItem, computeNutritionFlags } from '../models/FoodItem';

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

export default router;
