import { Router, Response, Request } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { CabinetItem, CabinetItemType } from '../models/CabinetItem';
import { SharedStack } from '../models/SharedStack';

const router = Router();

// POST /cabinet — add item
router.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
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
    userId: req.userId,
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
  const query: Record<string, unknown> = { userId: req.userId };

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

export default router;
