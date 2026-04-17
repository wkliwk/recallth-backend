import mongoose, { Document, Schema, Types } from 'mongoose';

// ─── Food item within a meal ───────────────────────────────────────────────

export interface IFoodItem {
  name: string;
  quantity: number;
  unit: string;
  grams?: number;
  nutrients: Map<string, number>;
}

const FoodItemSchema = new Schema<IFoodItem>(
  {
    name: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true, trim: true },
    grams: { type: Number },
    nutrients: {
      type: Map,
      of: Number,
      default: {},
    },
  },
  { _id: false }
);

// ─── MealEntry model ───────────────────────────────────────────────────────

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface IMealEntry extends Document {
  userId: Types.ObjectId;
  date: string;
  mealType: MealType;
  foods: IFoodItem[];
  rawText?: string;
  createdAt: Date;
}

const MealEntrySchema = new Schema<IMealEntry>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    mealType: {
      type: String,
      enum: ['breakfast', 'lunch', 'dinner', 'snack'],
      required: true,
    },
    foods: {
      type: [FoodItemSchema],
      default: [],
    },
    rawText: {
      type: String,
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

MealEntrySchema.index({ userId: 1, date: 1 });

export const MealEntry = mongoose.model<IMealEntry>('MealEntry', MealEntrySchema);

// ─── UserNutritionCategory model ───────────────────────────────────────────

export type NutritionCategory =
  | 'gym'
  | 'weight-loss'
  | 'diabetes'
  | 'kidney'
  | 'pregnancy'
  | 'custom';

export interface IUserNutritionCategory extends Document {
  userId: Types.ObjectId;
  category: NutritionCategory;
  updatedAt: Date;
}

const UserNutritionCategorySchema = new Schema<IUserNutritionCategory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    category: {
      type: String,
      enum: ['gym', 'weight-loss', 'diabetes', 'kidney', 'pregnancy', 'custom'],
      default: 'gym',
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

export const UserNutritionCategory = mongoose.model<IUserNutritionCategory>(
  'UserNutritionCategory',
  UserNutritionCategorySchema
);

// ─── UserNutritionCustomConfig model ──────────────────────────────────────

export interface IUserNutritionCustomConfig extends Document {
  userId: Types.ObjectId;
  nutrients: string[];
  goals: Map<string, number>;
  aiSetupDone: boolean;
  updatedAt: Date;
}

const UserNutritionCustomConfigSchema = new Schema<IUserNutritionCustomConfig>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    nutrients: {
      type: [String],
      default: ['calories', 'protein', 'carbs', 'fat'],
    },
    goals: {
      type: Map,
      of: Number,
      default: {},
    },
    aiSetupDone: {
      type: Boolean,
      default: false,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

export const UserNutritionCustomConfig = mongoose.model<IUserNutritionCustomConfig>(
  'UserNutritionCustomConfig',
  UserNutritionCustomConfigSchema
);
