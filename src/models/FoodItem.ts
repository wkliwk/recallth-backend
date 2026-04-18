import { Schema, model, Document, Types } from 'mongoose';

export type FoodCategory =
  | 'rice_noodles'
  | 'protein'
  | 'dim_sum'
  | 'soup'
  | 'bread_pastry'
  | 'drinks'
  | 'desserts'
  | 'snacks'
  | 'fast_food'
  | 'whole_food'
  | 'packaged';

export type AccuracyTier = 'A' | 'B' | 'C';
export type FoodSource = 'official' | 'openfoodfacts' | 'community' | 'reference' | 'ai_estimated';
export type FoodVenue = 'chain' | 'cha_chaan_teng' | 'dai_pai_dong' | 'home_cooked' | 'supermarket' | 'generic';
export type FoodLang = 'zh-HK' | 'en';
export type FoodStatus = 'active' | 'merged' | 'deprecated';

export interface NutrientsPer100g {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sugar?: number;
  fiber?: number;
  sodium?: number;
}

export interface NutritionFlags {
  highProtein: boolean;   // protein >= 20g per serving
  highFiber: boolean;     // fiber >= 6g per serving
  lowSugar: boolean;      // sugar <= 3g per serving
  lowSodium: boolean;     // sodium <= 140mg per serving
  lowCalorie: boolean;    // calories <= 200 per serving
  highCalorie: boolean;   // calories >= 500 per serving
}

export interface FoodComponent {
  foodItemId: Types.ObjectId;
  gramWeight: number;
}

export interface IFoodItem extends Document {
  name: string;
  displayName: string;
  aliases: string[];
  lang: FoodLang;
  category: FoodCategory;
  brand?: string;
  venue?: FoodVenue;
  per100g: NutrientsPer100g;
  defaultServingGrams: number;
  defaultServingUnit: string;
  source: FoodSource;
  accuracyTier: AccuracyTier;
  dataFreshnessDate: Date;
  contributionCount: number;
  nutritionFlags: NutritionFlags;
  searchCount: number;
  logCount: number;
  dishImageUrl?: string;
  labelImageUrl?: string;
  variantOf?: Types.ObjectId;
  components?: FoodComponent[];
  status: FoodStatus;
  createdAt: Date;
  updatedAt: Date;
}

export function computeNutritionFlags(per100g: NutrientsPer100g, servingGrams: number): NutritionFlags {
  const s = servingGrams / 100;
  const cal = (per100g.calories ?? 0) * s;
  const protein = (per100g.protein ?? 0) * s;
  const fiber = (per100g.fiber ?? 0) * s;
  const sugar = per100g.sugar != null ? per100g.sugar * s : null;
  const sodium = per100g.sodium != null ? per100g.sodium * s : null;

  return {
    highProtein: protein >= 20,
    highFiber: fiber >= 6,
    lowSugar: sugar != null ? sugar <= 3 : false,
    lowSodium: sodium != null ? sodium <= 140 : false,
    lowCalorie: cal <= 200,
    highCalorie: cal >= 500,
  };
}

const NutrientsPer100gSchema = new Schema<NutrientsPer100g>(
  {
    calories: { type: Number, required: true },
    protein:  { type: Number, required: true },
    carbs:    { type: Number, required: true },
    fat:      { type: Number, required: true },
    sugar:    { type: Number },
    fiber:    { type: Number },
    sodium:   { type: Number },
  },
  { _id: false }
);

const NutritionFlagsSchema = new Schema<NutritionFlags>(
  {
    highProtein: { type: Boolean, default: false },
    highFiber:   { type: Boolean, default: false },
    lowSugar:    { type: Boolean, default: false },
    lowSodium:   { type: Boolean, default: false },
    lowCalorie:  { type: Boolean, default: false },
    highCalorie: { type: Boolean, default: false },
  },
  { _id: false }
);

const FoodComponentSchema = new Schema<FoodComponent>(
  {
    foodItemId: { type: Schema.Types.ObjectId, ref: 'FoodItem', required: true },
    gramWeight: { type: Number, required: true },
  },
  { _id: false }
);

const FoodItemSchema = new Schema<IFoodItem>(
  {
    name:        { type: String, required: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true },
    aliases:     { type: [String], default: [] },
    lang:        { type: String, enum: ['zh-HK', 'en'], default: 'zh-HK' },
    category: {
      type: String,
      enum: ['rice_noodles', 'protein', 'dim_sum', 'soup', 'bread_pastry', 'drinks', 'desserts', 'snacks', 'fast_food', 'whole_food', 'packaged'],
      required: true,
    },
    brand:  { type: String },
    venue:  { type: String, enum: ['chain', 'cha_chaan_teng', 'dai_pai_dong', 'home_cooked', 'supermarket', 'generic'] },
    per100g: { type: NutrientsPer100gSchema, required: true },
    defaultServingGrams: { type: Number, required: true, default: 100 },
    defaultServingUnit:  { type: String, required: true, default: '份' },
    source: {
      type: String,
      enum: ['official', 'openfoodfacts', 'community', 'reference', 'ai_estimated'],
      required: true,
    },
    accuracyTier:      { type: String, enum: ['A', 'B', 'C'], required: true },
    dataFreshnessDate: { type: Date, required: true, default: Date.now },
    contributionCount: { type: Number, default: 0 },
    nutritionFlags:    { type: NutritionFlagsSchema, required: true },
    searchCount: { type: Number, default: 0 },
    logCount:    { type: Number, default: 0 },
    dishImageUrl:  { type: String },
    labelImageUrl: { type: String },
    variantOf:  { type: Schema.Types.ObjectId, ref: 'FoodItem' },
    components: { type: [FoodComponentSchema], default: undefined },
    status: { type: String, enum: ['active', 'merged', 'deprecated'], default: 'active' },
  },
  { timestamps: true }
);

// Indexes for fast search and filtering
FoodItemSchema.index({ name: 1 }, { unique: true });
FoodItemSchema.index({ aliases: 1 });
FoodItemSchema.index({ category: 1 });
FoodItemSchema.index({ logCount: -1 });
FoodItemSchema.index({ accuracyTier: 1 });
FoodItemSchema.index({ status: 1 });
FoodItemSchema.index({ 'nutritionFlags.highProtein': 1 });
FoodItemSchema.index({ 'nutritionFlags.highFiber': 1 });
FoodItemSchema.index({ 'nutritionFlags.lowSugar': 1 });
FoodItemSchema.index({ 'nutritionFlags.lowSodium': 1 });
FoodItemSchema.index({ 'nutritionFlags.lowCalorie': 1 });
FoodItemSchema.index({ 'nutritionFlags.highCalorie': 1 });

export const FoodItem = model<IFoodItem>('FoodItem', FoodItemSchema);
