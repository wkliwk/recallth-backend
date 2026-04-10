import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';

const router = Router();

const getGoogleClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not configured');
  return new OAuth2Client(clientId);
};

// POST /auth/google
// Body: { idToken: string }
router.post('/google', async (req: Request, res: Response): Promise<void> => {
  const { idToken } = req.body;

  if (!idToken) {
    res.status(400).json({ success: false, data: null, error: 'idToken is required' });
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ success: false, data: null, error: 'Google SSO not configured' });
    return;
  }

  const client = getGoogleClient();
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();

  if (!payload || !payload.email) {
    res.status(401).json({ success: false, data: null, error: 'Invalid Google token' });
    return;
  }

  const { email, sub: googleId, name: displayName } = payload;
  const normalizedEmail = email.toLowerCase();

  // Find existing user by email or googleId, or create new
  let user = await User.findOne({
    $or: [{ email: normalizedEmail }, { googleId }],
  });

  if (!user) {
    user = await User.create({
      email: normalizedEmail,
      googleId,
      displayName,
    });
  } else if (!user.googleId) {
    // Existing email/password user — link Google account
    user.googleId = googleId;
    if (displayName && !user.displayName) user.displayName = displayName;
    await user.save();
  }

  const secret = process.env.JWT_SECRET!;
  const token = jwt.sign({ userId: user._id.toString() }, secret, { expiresIn: '30d' });

  res.json({
    success: true,
    data: { token, userId: user._id, email: user.email, displayName: user.displayName },
    error: null,
  });
});

export default router;
