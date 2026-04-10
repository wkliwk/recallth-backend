import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { FamilyMember } from '../models/FamilyMember';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';

const router = Router();

// GET /family-members — list all family members for the authed user
router.get('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const members = await FamilyMember.find({ ownerId }).sort({ createdAt: 1 }).lean();
  res.json({ success: true, data: members, error: null });
});

// POST /family-members — create a new family member
router.post('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const { name, relationship } = req.body as { name?: string; relationship?: string };

  if (!name || typeof name !== 'string' || name.trim() === '') {
    res.status(400).json({ success: false, data: null, error: 'name is required' });
    return;
  }

  const member = await FamilyMember.create({
    ownerId,
    name: name.trim(),
    relationship: relationship?.trim() ?? undefined,
  });

  res.status(201).json({ success: true, data: member, error: null });
});

// DELETE /family-members/:id — delete a family member and their data
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const ownerId = new Types.ObjectId(req.userId);
  const memberId = String(req.params.id);

  if (!Types.ObjectId.isValid(memberId)) {
    res.status(400).json({ success: false, data: null, error: 'Invalid member id' });
    return;
  }

  const member = await FamilyMember.findOneAndDelete({ _id: memberId, ownerId });
  if (!member) {
    res.status(404).json({ success: false, data: null, error: 'Family member not found' });
    return;
  }

  // Cascade-delete their profile and cabinet data (keyed by member._id as their userId)
  await Promise.all([
    HealthProfile.deleteOne({ userId: member._id }),
    CabinetItem.deleteMany({ userId: member._id }),
  ]);

  res.json({ success: true, data: null, error: null });
});

export default router;
