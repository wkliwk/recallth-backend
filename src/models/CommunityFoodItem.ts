import { Schema, model, Document } from 'mongoose';

export interface NutrientsPer100g {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  sugar?: number;
  fiber?: number;
  sodium?: number;
}

export type CommunityFoodStatus = 'unverified' | 'community' | 'verified';

export interface ICommunityFoodItem extends Document {
  name: string;        // canonical (trimmed, lowercase)
  aliases: string[];
  per100g: NutrientsPer100g;
  contributionCount: number;
  calorieRange: { min: number; max: number };
  status: CommunityFoodStatus;
  lastUpdated: Date;
  // Internal fields for running variance (Welford's algorithm on calories per 100g)
  _calM2: number;       // sum of squared deviations from mean (for stddev)
  createdAt: Date;
  updatedAt: Date;
}

const NutrientsPer100gSchema = new Schema<NutrientsPer100g>(
  {
    calories: { type: Number },
    protein:  { type: Number },
    carbs:    { type: Number },
    fat:      { type: Number },
    sugar:    { type: Number },
    fiber:    { type: Number },
    sodium:   { type: Number },
  },
  { _id: false }
);

const CommunityFoodItemSchema = new Schema<ICommunityFoodItem>(
  {
    name:    { type: String, required: true, trim: true, lowercase: true },
    aliases: { type: [String], default: [] },
    per100g: { type: NutrientsPer100gSchema, default: {} },
    contributionCount: { type: Number, default: 0 },
    calorieRange: {
      type: new Schema({ min: Number, max: Number }, { _id: false }),
      default: { min: 0, max: 0 },
    },
    status: {
      type: String,
      enum: ['unverified', 'community', 'verified'],
      default: 'unverified',
    },
    lastUpdated: { type: Date, default: Date.now },
    _calM2: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Fast lookup by name or alias
CommunityFoodItemSchema.index({ name: 1 }, { unique: true });
CommunityFoodItemSchema.index({ aliases: 1 });

export const CommunityFoodItem = model<ICommunityFoodItem>('CommunityFoodItem', CommunityFoodItemSchema);
