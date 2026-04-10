import { Schema, model, Document, Types } from 'mongoose';

export interface IDailyLog extends Document {
  userId: Types.ObjectId;
  date: string; // YYYY-MM-DD
  mood: number; // 1-5
  energy: number; // 1-5
  notes?: string;
  createdAt: Date;
}

const DailyLogSchema = new Schema<IDailyLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    mood: { type: Number, required: true, min: 1, max: 5 },
    energy: { type: Number, required: true, min: 1, max: 5 },
    notes: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);
DailyLogSchema.index({ userId: 1, date: 1 }, { unique: true });

export const DailyLog = model<IDailyLog>('DailyLog', DailyLogSchema);
