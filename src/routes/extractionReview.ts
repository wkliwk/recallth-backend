import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { AuthRequest } from '../middleware/auth';
import { ExtractionReview } from '../models/ExtractionReview';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetItem } from '../models/CabinetItem';

const router = Router();

// ─── GET /profile/auto-extracted ───────────────────────────────────────────
// List all pending and processed AI-extracted entries for the authenticated user

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
      return;
    }

    const userId = new Types.ObjectId(req.userId);

    // Query all extraction reviews for this user
    const items = await ExtractionReview.find({ userId })
      .sort({ extractedAt: -1 })
      .lean();

    const total = items.length;

    res.json({
      success: true,
      data: { items, total },
      error: null,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({
      success: false,
      data: null,
      error,
    });
  }
});

// ─── PUT /profile/auto-extracted/:id ───────────────────────────────────────
// User confirms, corrects, or rejects an AI-extracted entry

interface ReviewActionRequest extends AuthRequest {
  body: {
    action: 'confirm' | 'correct' | 'reject';
    correctedValue?: unknown;
  };
}

router.put('/:id', async (req: ReviewActionRequest, res: Response): Promise<void> => {
  try {
    if (!req.userId) {
      res.status(401).json({ success: false, data: null, error: 'Unauthorized' });
      return;
    }

    const { action, correctedValue } = req.body;

    // Validate action
    if (!action || !['confirm', 'correct', 'reject'].includes(action)) {
      res.status(400).json({
        success: false,
        data: null,
        error: "action must be one of: 'confirm', 'correct', 'reject'",
      });
      return;
    }

    // Validate correctedValue is provided for 'correct' action
    if (action === 'correct' && correctedValue === undefined) {
      res.status(400).json({
        success: false,
        data: null,
        error: "correctedValue is required when action is 'correct'",
      });
      return;
    }

    const userId = new Types.ObjectId(req.userId);
    const paramId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const reviewId = new Types.ObjectId(paramId);

    // Fetch the review record
    const review = await ExtractionReview.findOne({
      _id: reviewId,
      userId,
    });

    if (!review) {
      res.status(404).json({
        success: false,
        data: null,
        error: 'Extraction review not found',
      });
      return;
    }

    const now = new Date();

    // Handle different actions
    if (action === 'confirm') {
      review.status = 'confirmed';
      review.reviewedAt = now;
      await review.save();
    } else if (action === 'correct') {
      review.status = 'corrected';
      review.correctedValue = correctedValue;
      review.reviewedAt = now;
      await review.save();

      // Apply correction to the actual profile or cabinet
      await applyCorrection(userId, review.source, review.field, correctedValue, review.sourceId);
    } else if (action === 'reject') {
      review.status = 'rejected';
      review.reviewedAt = now;
      await review.save();

      // Remove the extracted value from profile or cabinet
      await removeExtractedValue(userId, review.source, review.field, review.sourceId);
    }

    res.json({
      success: true,
      data: review,
      error: null,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({
      success: false,
      data: null,
      error,
    });
  }
});

// ─── Helper: Apply correction to profile or cabinet ────────────────────────

async function applyCorrection(
  userId: Types.ObjectId,
  source: string,
  field: string,
  correctedValue: unknown,
  sourceId?: Types.ObjectId
): Promise<void> {
  if (source === 'profile') {
    // field is in dot notation (e.g., 'body.weight')
    await HealthProfile.findOneAndUpdate(
      { userId },
      { $set: { [field]: correctedValue } },
      { new: true }
    );
  } else if (source === 'cabinet' && sourceId) {
    // field is the cabinet field name (e.g., 'dosage', 'frequency')
    await CabinetItem.findOneAndUpdate(
      { _id: sourceId, userId },
      { $set: { [field]: correctedValue } },
      { new: true }
    );
  }
}

// ─── Helper: Remove extracted value from profile or cabinet ────────────────

async function removeExtractedValue(
  userId: Types.ObjectId,
  source: string,
  field: string,
  sourceId?: Types.ObjectId
): Promise<void> {
  if (source === 'profile') {
    // field is in dot notation (e.g., 'body.weight')
    const unsetPayload: Record<string, number> = {};
    unsetPayload[field] = 1;
    await HealthProfile.findOneAndUpdate(
      { userId },
      { $unset: unsetPayload },
      { new: true }
    );
  } else if (source === 'cabinet' && sourceId) {
    // For cabinet items, we'll set the field to null/undefined rather than delete
    // This preserves the item but removes the specific field
    const unsetPayload: Record<string, number> = {};
    unsetPayload[field] = 1;
    await CabinetItem.findOneAndUpdate(
      { _id: sourceId, userId },
      { $unset: unsetPayload },
      { new: true }
    );
  }
}

export default router;
