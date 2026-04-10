import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Conversation } from '../models/Conversation';
import { HealthProfile } from '../models/HealthProfile';
import { CabinetChangeLog } from '../models/CabinetChangeLog';

const historyRouter = Router();

// All routes require auth
historyRouter.use(authenticate);

/**
 * Parse and validate pagination query params.
 * page: default 1, min 1
 * limit: default 20, max 50
 */
function parsePagination(query: Record<string, unknown>): { page: number; limit: number; skip: number } {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const rawLimit = parseInt(String(query.limit ?? '20'), 10) || 20;
  const limit = Math.min(50, Math.max(1, rawLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── GET /history/conversations ───────────────────────────────────────────
// Paginated list of conversations with messageCount and firstMessage preview.
historyRouter.get('/conversations', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const [conversations, total] = await Promise.all([
      Conversation.aggregate([
        { $match: { userId: new Types.ObjectId(userId) } },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: 1,
            title: 1,
            createdAt: 1,
            messageCount: { $size: '$messages' },
            firstMessage: {
              $cond: {
                if: { $gt: [{ $size: '$messages' }, 0] },
                then: { $substr: [{ $arrayElemAt: ['$messages.content', 0] }, 0, 100] },
                else: null,
              },
            },
          },
        },
      ]),
      Conversation.countDocuments({ userId: new Types.ObjectId(userId) }),
    ]);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        data: conversations,
        total,
        page,
        limit,
        hasMore: skip + conversations.length < total,
      },
    });
  } catch (err) {
    console.error('[GET /history/conversations]', err);
    res.status(500).json({ success: false, error: 'Internal server error', data: null });
  }
});

// ─── GET /history/conversations/search ───────────────────────────────────
// Search conversation message content by keyword (case-insensitive).
historyRouter.get('/conversations/search', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const q = String(req.query.q ?? '').trim();

    if (!q) {
      res.status(400).json({ success: false, error: 'q query parameter is required', data: null });
      return;
    }

    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    // Case-insensitive regex search across message content
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const matchStage = {
      userId: new Types.ObjectId(userId),
      'messages.content': regex,
    };

    const [conversations, total] = await Promise.all([
      Conversation.aggregate([
        { $match: matchStage },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $project: {
            _id: 1,
            title: 1,
            createdAt: 1,
            messageCount: { $size: '$messages' },
            // Return the first matching message snippet
            matchingSnippet: {
              $let: {
                vars: {
                  matchingMsg: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: '$messages',
                          as: 'msg',
                          cond: { $regexMatch: { input: '$$msg.content', regex: q, options: 'i' } },
                        },
                      },
                      0,
                    ],
                  },
                },
                in: { $substr: ['$$matchingMsg.content', 0, 200] },
              },
            },
          },
        },
      ]),
      Conversation.countDocuments(matchStage),
    ]);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        data: conversations,
        total,
        page,
        limit,
        hasMore: skip + conversations.length < total,
      },
    });
  } catch (err) {
    console.error('[GET /history/conversations/search]', err);
    res.status(500).json({ success: false, error: 'Internal server error', data: null });
  }
});

// ─── GET /history/profile ─────────────────────────────────────────────────
// Returns all profile change history entries for the authenticated user.
historyRouter.get('/profile', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const profile = await HealthProfile.findOne(
      { userId: new Types.ObjectId(userId) },
      { changeHistory: 1 }
    ).lean();

    if (!profile) {
      res.status(200).json({
        success: true,
        error: null,
        data: { data: [], total: 0, page, limit, hasMore: false },
      });
      return;
    }

    const allChanges = [...(profile.changeHistory ?? [])].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const total = allChanges.length;
    const data = allChanges.slice(skip, skip + limit);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        data,
        total,
        page,
        limit,
        hasMore: skip + data.length < total,
      },
    });
  } catch (err) {
    console.error('[GET /history/profile]', err);
    res.status(500).json({ success: false, error: 'Internal server error', data: null });
  }
});

// ─── GET /history/cabinet ─────────────────────────────────────────────────
// Returns paginated cabinet change log for the authenticated user.
historyRouter.get('/cabinet', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const [logs, total] = await Promise.all([
      CabinetChangeLog.find({ userId: new Types.ObjectId(userId) })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CabinetChangeLog.countDocuments({ userId: new Types.ObjectId(userId) }),
    ]);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        data: logs,
        total,
        page,
        limit,
        hasMore: skip + logs.length < total,
      },
    });
  } catch (err) {
    console.error('[GET /history/cabinet]', err);
    res.status(500).json({ success: false, error: 'Internal server error', data: null });
  }
});

// ─── GET /history/timeline ────────────────────────────────────────────────
// Merged chronological timeline: conversations + profile changes + cabinet changes.
historyRouter.get('/timeline', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.userId as string;
    const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

    const userObjId = new Types.ObjectId(userId);

    // Fetch all three sources in parallel
    const [conversations, profile, cabinetLogs] = await Promise.all([
      Conversation.aggregate([
        { $match: { userId: userObjId } },
        {
          $project: {
            _id: 1,
            title: 1,
            createdAt: 1,
            messageCount: { $size: '$messages' },
            firstMessage: {
              $cond: {
                if: { $gt: [{ $size: '$messages' }, 0] },
                then: { $substr: [{ $arrayElemAt: ['$messages.content', 0] }, 0, 100] },
                else: null,
              },
            },
          },
        },
      ]),
      HealthProfile.findOne({ userId: userObjId }, { changeHistory: 1 }).lean(),
      CabinetChangeLog.find({ userId: userObjId }).sort({ timestamp: -1 }).lean(),
    ]);

    type TimelineEntry =
      | {
          type: 'conversation';
          timestamp: Date;
          summary: string;
          data: Record<string, unknown>;
        }
      | {
          type: 'profile_change';
          timestamp: Date;
          summary: string;
          data: Record<string, unknown>;
        }
      | {
          type: 'cabinet_change';
          timestamp: Date;
          summary: string;
          data: Record<string, unknown>;
        };

    const entries: TimelineEntry[] = [];

    for (const conv of conversations) {
      entries.push({
        type: 'conversation',
        timestamp: conv.createdAt as Date,
        summary: (conv.title as string) || 'Conversation',
        data: conv as Record<string, unknown>,
      });
    }

    for (const change of profile?.changeHistory ?? []) {
      entries.push({
        type: 'profile_change',
        timestamp: change.timestamp,
        summary: `Profile field "${change.field}" updated`,
        data: change as unknown as Record<string, unknown>,
      });
    }

    for (const log of cabinetLogs) {
      entries.push({
        type: 'cabinet_change',
        timestamp: log.timestamp,
        summary: `${log.action.charAt(0).toUpperCase() + log.action.slice(1)} ${log.itemName}`,
        data: log as unknown as Record<string, unknown>,
      });
    }

    // Sort descending by timestamp
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = entries.length;
    const data = entries.slice(skip, skip + limit);

    res.status(200).json({
      success: true,
      error: null,
      data: {
        data,
        total,
        page,
        limit,
        hasMore: skip + data.length < total,
      },
    });
  } catch (err) {
    console.error('[GET /history/timeline]', err);
    res.status(500).json({ success: false, error: 'Internal server error', data: null });
  }
});

export default historyRouter;
