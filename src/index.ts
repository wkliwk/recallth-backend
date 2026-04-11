import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './utils/db';
import { errorHandler } from './middleware/errorHandler';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import authGoogleRouter from './routes/authGoogle';
import profileRouter from './routes/profile';
import cabinetRouter from './routes/cabinet';
import chatRouter from './routes/chat';
import interactionsRouter from './routes/interactions';
import historyRouter from './routes/history';
import extractionReviewRouter from './routes/extractionReview';
import familyMembersRouter from './routes/familyMembers';
import wellnessRouter from './routes/wellness';
import sideEffectsRouter from './routes/sideEffects';
import exportRouter from './routes/export';
import journalRouter from './routes/journal';
import { bloodworkRouter } from './routes/bloodwork';
import { insightsRouter } from './routes/insights';
import { scheduleRouter } from './routes/schedule';
import { intakeRouter } from './routes/intake';
import { settingsRouter } from './routes/settings';
import { goalsRouter } from './routes/goals';
import digestRouter from './routes/digest';
import { authenticate } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/auth', authGoogleRouter);
app.use('/profile', profileRouter);
app.use('/profile/auto-extracted', authenticate, extractionReviewRouter);
app.use('/cabinet', authenticate, cabinetRouter);
app.use('/cabinet/interactions', authenticate, interactionsRouter);
app.use('/chat', authenticate, chatRouter);
app.use('/history', authenticate, historyRouter);
app.use('/family-members', familyMembersRouter);
app.use('/wellness', authenticate, wellnessRouter);
app.use('/side-effects', authenticate, sideEffectsRouter);
app.use('/export', authenticate, exportRouter);
app.use('/journal', journalRouter);
app.use('/bloodwork', bloodworkRouter);
app.use('/insights', insightsRouter);
app.use('/schedule', scheduleRouter);
app.use('/intake', intakeRouter);
app.use('/settings', authenticate, settingsRouter);
app.use('/goals', goalsRouter);
app.use('/digest', authenticate, digestRouter);

// Error handling
app.use(errorHandler);

const start = async () => {
  await connectDB();
  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Recallth API running on port ${PORT}`);
  });
};

start();

export default app;
