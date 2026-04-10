import mongoose, { Document, Schema, Types } from 'mongoose';

export type CabinetAction = 'added' | 'updated' | 'archived' | 'deleted';

export interface IFieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ICabinetChangeLog extends Document {
  userId: Types.ObjectId;
  itemId: Types.ObjectId;
  itemName: string;
  action: CabinetAction;
  changes: IFieldChange[];
  timestamp: Date;
}

const FieldChangeSchema = new Schema<IFieldChange>(
  {
    field: { type: String, required: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const CabinetChangeLogSchema = new Schema<ICabinetChangeLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'CabinetItem', required: true },
    itemName: { type: String, required: true },
    action: {
      type: String,
      enum: ['added', 'updated', 'archived', 'deleted'],
      required: true,
    },
    changes: { type: [FieldChangeSchema], default: [] },
    timestamp: { type: Date, default: Date.now, required: true, index: true },
  },
  { timestamps: false }
);

CabinetChangeLogSchema.index({ userId: 1, timestamp: -1 });

export const CabinetChangeLog = mongoose.model<ICabinetChangeLog>(
  'CabinetChangeLog',
  CabinetChangeLogSchema
);
