import { Schema, model, Document, Types } from 'mongoose';

export interface IBodyStatEntry extends Document {
  userId: Types.ObjectId;
  date: string; // YYYY-MM-DD
  weight?: number;    // kg
  bodyFat?: number;   // %
  muscleMass?: number; // kg
  waist?: number;     // cm
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BodyStatEntrySchema = new Schema<IBodyStatEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    weight: { type: Number },
    bodyFat: { type: Number },
    muscleMass: { type: Number },
    waist: { type: Number },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

BodyStatEntrySchema.index({ userId: 1, date: -1 });

export const BodyStatEntry = model<IBodyStatEntry>('BodyStatEntry', BodyStatEntrySchema);
