import { Schema, model, Document } from 'mongoose';

export interface INutritionOffCache extends Document {
  query: string;           // normalised search term (lowercase)
  offProductName: string;
  per100g: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    sugar?: number;
    fiber?: number;
    sodium?: number;
  };
  fetchedAt: Date;
}

const NutritionOffCacheSchema = new Schema<INutritionOffCache>(
  {
    query: { type: String, required: true, unique: true, index: true },
    offProductName: { type: String, required: true },
    per100g: {
      calories: Number,
      protein: Number,
      carbs: Number,
      fat: Number,
      sugar: Number,
      fiber: Number,
      sodium: Number,
    },
    fetchedAt: { type: Date, required: true },
  },
  { timestamps: false }
);

// Auto-expire after 7 days
NutritionOffCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export const NutritionOffCache = model<INutritionOffCache>('NutritionOffCache', NutritionOffCacheSchema);
