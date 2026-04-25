import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
const SALT_ROUNDS = 12;

// POST /auth/register
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, data: null, error: 'Email and password are required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ success: false, data: null, error: 'Password must be at least 8 characters' });
    return;
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    res.status(409).json({ success: false, data: null, error: 'Email already registered' });
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({ email: email.toLowerCase(), passwordHash });

  const secret = process.env.JWT_SECRET!;
  const token = jwt.sign({ userId: user._id.toString() }, secret, { expiresIn: '30d' });

  res.status(201).json({
    success: true,
    data: { token, userId: user._id, email: user.email },
    error: null,
  });
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ success: false, data: null, error: 'Email and password are required' });
    return;
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    res.status(401).json({ success: false, data: null, error: 'Invalid credentials' });
    return;
  }

  if (!user.passwordHash) {
    res.status(401).json({ success: false, data: null, error: 'No password set for this account. Please sign in with Google, or set a password in your account settings.' });
    return;
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ success: false, data: null, error: 'Invalid credentials' });
    return;
  }

  const secret = process.env.JWT_SECRET!;
  const token = jwt.sign({ userId: user._id.toString() }, secret, { expiresIn: '30d' });

  res.json({
    success: true,
    data: { token, userId: user._id, email: user.email },
    error: null,
  });
});

// POST /auth/set-password
router.post('/set-password', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    res.status(400).json({ success: false, data: null, error: 'Password is required' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ success: false, data: null, error: 'Password must be at least 8 characters' });
    return;
  }

  const user = await User.findById(req.userId);
  if (!user) {
    res.status(404).json({ success: false, data: null, error: 'User not found' });
    return;
  }

  if (user.passwordHash) {
    res.status(400).json({ success: false, data: null, error: 'Password already set for this account' });
    return;
  }

  user.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await user.save();

  res.json({ success: true, data: null, error: null });
});

// GET /auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await User.findById(req.userId);
  if (!user) {
    res.status(404).json({ success: false, data: null, error: 'User not found' });
    return;
  }
  res.json({
    success: true,
    data: {
      userId: user._id,
      email: user.email,
      hasPassword: !!user.passwordHash,
      googleLinked: !!user.googleId,
      isAdmin: user.isAdmin ?? false,
    },
    error: null,
  });
});

// POST /auth/link-google
router.post('/link-google', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const { googleToken } = req.body;

  if (!googleToken || typeof googleToken !== 'string') {
    res.status(400).json({ success: false, data: null, error: 'googleToken is required' });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ success: false, data: null, error: 'Google SSO not configured' });
    return;
  }

  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken: googleToken, audience: clientId });
  const payload = ticket.getPayload();

  if (!payload || !payload.sub) {
    res.status(401).json({ success: false, data: null, error: 'Invalid Google token' });
    return;
  }

  const googleId = payload.sub;

  // Check if this Google account is already linked to a different user
  const existingLinked = await User.findOne({ googleId });
  if (existingLinked && existingLinked._id.toString() !== req.userId) {
    res.status(409).json({ success: false, data: null, error: 'This Google account is already linked to another user' });
    return;
  }

  const user = await User.findById(req.userId);
  if (!user) {
    res.status(404).json({ success: false, data: null, error: 'User not found' });
    return;
  }

  user.googleId = googleId;
  await user.save();

  res.json({ success: true, data: null, error: null });
});

export default router;
