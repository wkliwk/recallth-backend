import cron from 'node-cron';
import { UserSettings } from '../models/UserSettings';

// Dedup: tracks "userId:YYYY-MM-DD:HH:MM" keys to prevent double-fire within the same minute
const firedKeys = new Set<string>();

function getHHMM(tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function getDateStr(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function startReminderJob(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const allSettings = await UserSettings.find({ remindersEnabled: true }).lean();

      for (const settings of allSettings) {
        const tz = settings.timezone || 'UTC';
        const currentHHMM = getHHMM(tz);

        if (!settings.reminderTimes.includes(currentHHMM)) continue;

        const userId = settings.userId.toString();
        const dedupeKey = `${userId}:${getDateStr(tz)}:${currentHHMM}`;

        if (firedKeys.has(dedupeKey)) continue;
        firedKeys.add(dedupeKey);

        console.log(`[ReminderJob] Reminder fired for user ${userId} at ${currentHHMM} (${tz})`);
      }
    } catch (err) {
      console.error('[ReminderJob] Error in reminder cron:', err);
    }
  });

  console.log('[ReminderJob] Reminder scheduler started (runs every minute)');
}
