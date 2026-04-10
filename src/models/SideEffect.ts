import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISideEffect extends Document {
  userId: Types.ObjectId;
  cabinetItemId: Types.ObjectId;
  date: Date;
  symptom: string;
  rating: 1 | 2 | 3 | 4 | 5;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SideEffectSchema = new Schema<ISideEffect>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    cabinetItemId: { type: Schema.Types.ObjectId, ref: 'CabinetItem', required: true, index: true },
    date: { type: Date, required: true },
    symptom: { type: String, required: true, trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

export const SideEffect = mongoose.model<ISideEffect>('SideEffect', SideEffectSchema);
