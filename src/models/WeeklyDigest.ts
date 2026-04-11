import { Schema, model, Document, Types } from 'mongoose';

export interface IWeeklyDigestStats {
  avgMood: number | null;
  avgEnergy: number | null;
  goalLoggingRate: number; // 0–1 fraction of 7 days
  bloodworkCount: number;
  chatCount: number;
  journalCount: number;
}

export interface IWeeklyDigest extends Document {
  userId: Types.ObjectId;
  weekKey: string;   // YYYY-MM-DD Monday of the week
  weekEnd: string;   // YYYY-MM-DD Sunday of the week
  summary: string;
  suggestion: string;
  stats: IWeeklyDigestStats;
  generatedAt: Date;
}

const WeeklyDigestSchema = new Schema<IWeeklyDigest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    weekKey: { type: String, required: true },
    weekEnd: { type: String, required: true },
    summary: { type: String, required: true },
    suggestion: { type: String, required: true },
    stats: {
      avgMood: { type: Number, default: null },
      avgEnergy: { type: Number, default: null },
      goalLoggingRate: { type: Number, default: 0 },
      bloodworkCount: { type: Number, default: 0 },
      chatCount: { type: Number, default: 0 },
      journalCount: { type: Number, default: 0 },
    },
    generatedAt: { type: Date, required: true },
  },
  { timestamps: false }
);
WeeklyDigestSchema.index({ userId: 1, weekKey: 1 }, { unique: true });

export const WeeklyDigest = model<IWeeklyDigest>('WeeklyDigest', WeeklyDigestSchema);
