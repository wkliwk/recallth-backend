import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { authenticate, AuthRequest } from '../middleware/auth';
import { processChat, checkRateLimit } from '../services/chatService';
import { Conversation } from '../models/Conversation';

const chatRouter = Router();

// All routes require auth
chatRouter.use(authenticate);

// POST /chat — send message, get AI response
chatRouter.post('/', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const { message, conversationId } = req.body as {
    message?: string;
    conversationId?: string;
  };

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ success: false, error: 'message is required', data: null });
    return;
  }

  if (message.trim().length > 4000) {
    res.status(400).json({ success: false, error: 'message too long (max 4000 characters)', data: null });
    return;
  }

  if (conversationId && !Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, error: 'invalid conversationId', data: null });
    return;
  }

  // Rate limiting
  const rateCheck = checkRateLimit(userId);
  if (!rateCheck.allowed) {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Maximum 30 messages per hour.',
      data: {
        resetAt: new Date(rateCheck.resetAt).toISOString(),
        remaining: 0,
      },
    });
    return;
  }

  const result = await processChat(userId, message.trim(), conversationId);

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversationId: result.conversationId,
      message: result.message,
      extractedData: result.extractedData,
    },
  });
});

// GET /chat/history — list conversations (paginated, 20/page)
chatRouter.get('/history', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const limit = 20;
  const skip = (page - 1) * limit;

  const conversations = await Conversation.aggregate([
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
      },
    },
  ]);

  res.status(200).json({
    success: true,
    error: null,
    data: {
      conversations,
      page,
      limit,
    },
  });
});

// GET /chat/:conversationId — get full conversation
chatRouter.get('/:conversationId', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId as string;
  const conversationId = String(req.params.conversationId);

  if (!Types.ObjectId.isValid(conversationId)) {
    res.status(400).json({ success: false, error: 'invalid conversationId', data: null });
    return;
  }

  const conversation = await Conversation.findOne({
    _id: new Types.ObjectId(conversationId),
    userId: new Types.ObjectId(userId),
  });

  if (!conversation) {
    res.status(404).json({ success: false, error: 'Conversation not found', data: null });
    return;
  }

  res.status(200).json({
    success: true,
    error: null,
    data: conversation,
  });
});

export default chatRouter;
