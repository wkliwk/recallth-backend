import { Schema, model, Document, Types } from 'mongoose';

export interface IGoalCheckIn extends Document {
  userId: Types.ObjectId;
  goal: string;
  rating: number; // 1-5
  notes?: string;
  weekStart: string; // YYYY-MM-DD (Monday of the week)
  aiResponse?: string;
  createdAt: Date;
}

const GoalCheckInSchema = new Schema<IGoalCheckIn>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    goal: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    notes: { type: String, maxlength: 500 },
    weekStart: { type: String, required: true },
    aiResponse: { type: String },
  },
  { timestamps: true }
);

// One check-in per goal per week per user
GoalCheckInSchema.index({ userId: 1, goal: 1, weekStart: 1 }, { unique: true });

export const GoalCheckIn = model<IGoalCheckIn>('GoalCheckIn', GoalCheckInSchema);
