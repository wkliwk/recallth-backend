import { Schema, model, Document, Types } from 'mongoose';

export interface IUserFoodItem extends Document {
  userId: Types.ObjectId;
  name: string;        // normalised (trimmed, lowercase) — used for matching
  displayName: string; // original display name shown to user
  brand: string;
  servingSize: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  sugar: number | null;
  fiber: number | null;
  sodium: number | null;
  useCount: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserFoodItemSchema = new Schema<IUserFoodItem>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true },
    displayName: { type: String, required: true },
    brand: { type: String, default: '' },
    servingSize: { type: String, default: '' },
    calories: { type: Number, default: null },
    protein: { type: Number, default: null },
    carbs: { type: Number, default: null },
    fat: { type: Number, default: null },
    sugar: { type: Number, default: null },
    fiber: { type: Number, default: null },
    sodium: { type: Number, default: null },
    useCount: { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Compound index for fast user + name lookup and search
UserFoodItemSchema.index({ userId: 1, name: 1 });
UserFoodItemSchema.index({ userId: 1, useCount: -1, lastUsedAt: -1 });

export const UserFoodItem = model<IUserFoodItem>('UserFoodItem', UserFoodItemSchema);
