import { Schema, model, Document, Types } from 'mongoose';

export interface IBloodworkEntry extends Document {
  userId: Types.ObjectId;
  date: string; // YYYY-MM-DD
  marker: string;
  value: number;
  unit: string;
  createdAt: Date;
}

const BloodworkEntrySchema = new Schema<IBloodworkEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    marker: { type: String, required: true, trim: true },
    value: { type: Number, required: true },
    unit: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

BloodworkEntrySchema.index({ userId: 1, marker: 1, date: 1 });

export const BloodworkEntry = model<IBloodworkEntry>('BloodworkEntry', BloodworkEntrySchema);
