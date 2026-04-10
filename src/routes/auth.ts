import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';

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
    res.status(401).json({ success: false, data: null, error: 'This account uses Google Sign-In. Please use "Continue with Google".' });
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

export default router;
