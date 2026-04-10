import { Schema, model, Document, Types } from 'mongoose';

export interface IIntakeLog extends Document {
  userId: Types.ObjectId;
  date: string; // YYYY-MM-DD UTC
  createdAt: Date;
}

const IntakeLogSchema = new Schema<IIntakeLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
  },
  { timestamps: true },
);

IntakeLogSchema.index({ userId: 1, date: 1 }, { unique: true });

export const IntakeLog = model<IIntakeLog>('IntakeLog', IntakeLogSchema);
