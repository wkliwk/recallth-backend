import { Schema, model, Document, Types } from 'mongoose';

export interface IDoseEffect extends Document {
  userId: Types.ObjectId;
  doseLogId: Types.ObjectId;
  supplementId: Types.ObjectId;
  supplementName: string;
  energy?: number;
  focus?: number;
  sleep?: number;
  mood?: number;
  ratedAt: Date;
  createdAt: Date;
}

const DoseEffectSchema = new Schema<IDoseEffect>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doseLogId: { type: Schema.Types.ObjectId, ref: 'DoseLog', required: true },
    supplementId: { type: Schema.Types.ObjectId, ref: 'CabinetItem', required: true },
    supplementName: { type: String, required: true },
    energy: { type: Number, min: 1, max: 5 },
    focus: { type: Number, min: 1, max: 5 },
    sleep: { type: Number, min: 1, max: 5 },
    mood: { type: Number, min: 1, max: 5 },
    ratedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

DoseEffectSchema.index({ userId: 1, ratedAt: -1 });
DoseEffectSchema.index({ userId: 1, supplementId: 1 });
DoseEffectSchema.index({ doseLogId: 1 }, { unique: true });

export const DoseEffect = model<IDoseEffect>('DoseEffect', DoseEffectSchema);
