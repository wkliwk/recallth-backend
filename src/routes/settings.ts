import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { UserSettings } from '../models/UserSettings';
import { Types } from 'mongoose';

const router = Router();

const ALLOWED_FIELDS = new Set([
  'remindersEnabled',
  'reminderTimes',
  'timezone',
  'emailDigestEnabled',
  'emailDigestDay',
]);

const VALID_DAYS = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

// GET /settings — return current user settings (defaults if never set)
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = new Types.ObjectId(req.userId);
    const settings = await UserSettings.findOne({ userId }).lean();

    if (!settings) {
      return res.json({
        remindersEnabled: false,
        reminderTimes: [],
        timezone: 'UTC',
        emailDigestEnabled: false,
        emailDigestDay: 'sunday',
      });
    }

    return res.json({
      remindersEnabled: settings.remindersEnabled,
      reminderTimes: settings.reminderTimes,
      timezone: settings.timezone,
      emailDigestEnabled: settings.emailDigestEnabled,
      emailDigestDay: settings.emailDigestDay,
    });
  } catch (error) {
    console.error('Settings GET error:', error);
    return res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// PATCH /settings — partial update
router.patch('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Reject unknown fields
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return res.status(400).json({ error: `Unknown fields: ${unknownFields.join(', ')}` });
    }

    // Validate field values
    if ('remindersEnabled' in body && typeof body.remindersEnabled !== 'boolean') {
      return res.status(400).json({ error: 'remindersEnabled must be a boolean' });
    }
    if ('emailDigestEnabled' in body && typeof body.emailDigestEnabled !== 'boolean') {
      return res.status(400).json({ error: 'emailDigestEnabled must be a boolean' });
    }
    if ('timezone' in body) {
      if (typeof body.timezone !== 'string' || body.timezone.trim().length === 0) {
        return res.status(400).json({ error: 'timezone must be a non-empty string' });
      }
    }
    if ('emailDigestDay' in body) {
      if (typeof body.emailDigestDay !== 'string' || !VALID_DAYS.has(body.emailDigestDay.toLowerCase())) {
        return res.status(400).json({ error: 'emailDigestDay must be a valid day name' });
      }
    }
    if ('reminderTimes' in body) {
      if (!Array.isArray(body.reminderTimes) || !body.reminderTimes.every((t) => typeof t === 'string' && TIME_REGEX.test(t))) {
        return res.status(400).json({ error: 'reminderTimes must be an array of HH:MM strings' });
      }
    }

    const userId = new Types.ObjectId(req.userId);
    const updated = await UserSettings.findOneAndUpdate(
      { userId },
      { $set: body },
      { upsert: true, new: true },
    ).lean();

    return res.json({
      remindersEnabled: updated!.remindersEnabled,
      reminderTimes: updated!.reminderTimes,
      timezone: updated!.timezone,
      emailDigestEnabled: updated!.emailDigestEnabled,
      emailDigestDay: updated!.emailDigestDay,
    });
  } catch (error) {
    console.error('Settings PATCH error:', error);
    return res.status(500).json({ error: 'Failed to update settings' });
  }
});

export { router as settingsRouter };
