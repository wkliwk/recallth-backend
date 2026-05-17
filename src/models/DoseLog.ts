import { Schema, model, Document, Types } from 'mongoose';

export interface IDoseLog extends Document {
  userId: Types.ObjectId;
  supplementId: Types.ObjectId;
  supplementName: string;
  slot: string;
  takenAt: Date;
  late?: boolean;
  createdAt: Date;
}

const DoseLogSchema = new Schema<IDoseLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    supplementId: { type: Schema.Types.ObjectId, ref: 'CabinetItem', required: true },
    supplementName: { type: String, required: true },
    slot: { type: String, default: '' },
    takenAt: { type: Date, required: true },
    late: { type: Boolean, default: false },
  },
  { timestamps: true }
);

DoseLogSchema.index({ userId: 1, takenAt: -1 });
DoseLogSchema.index({ userId: 1, supplementId: 1, takenAt: -1 });

export const DoseLog = model<IDoseLog>('DoseLog', DoseLogSchema);
