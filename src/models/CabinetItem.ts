import mongoose, { Document, Schema, Types } from 'mongoose';

export type CabinetItemType = 'supplement' | 'medication' | 'vitamin';
export type CabinetItemSource = 'user_input' | 'ai_extracted';

export interface ICabinetItem extends Document {
  userId: Types.ObjectId;
  name: string;
  type: CabinetItemType;
  dosage?: string;
  frequency?: string;
  timing?: string;
  brand?: string;
  notes?: string;
  active: boolean;
  startDate: Date;
  endDate?: Date;
  source: CabinetItemSource;
  price?: number;
  currency?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CabinetItemSchema = new Schema<ICabinetItem>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['supplement', 'medication', 'vitamin'],
      required: true,
    },
    dosage: {
      type: String,
      trim: true,
    },
    frequency: {
      type: String,
      trim: true,
    },
    timing: {
      type: String,
      trim: true,
    },
    brand: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    startDate: {
      type: Date,
      default: () => new Date(),
    },
    endDate: {
      type: Date,
    },
    source: {
      type: String,
      enum: ['user_input', 'ai_extracted'],
      default: 'user_input',
    },
    price: {
      type: Number,
      min: 0,
    },
    currency: {
      type: String,
      trim: true,
      default: 'HKD',
    },
  },
  { timestamps: true }
);

export const CabinetItem = mongoose.model<ICabinetItem>('CabinetItem', CabinetItemSchema);
