import mongoose, { Document, Schema, Types } from 'mongoose';

// ─── Sub-document interfaces ───────────────────────────────────────────────

export interface IBody {
  height?: number; // cm
  weight?: number; // kg
  age?: number;
  sex?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  bodyCompositionGoals?: string;
}

export interface IDiet {
  preferences?: string[];
  allergies?: string[];
  intolerances?: string[];
  dietType?: string; // e.g. 'vegan', 'keto', 'mediterranean'
}

export interface IExercise {
  type?: string[]; // e.g. ['running', 'weightlifting']
  frequency?: string; // e.g. '3x per week'
  intensity?: 'low' | 'moderate' | 'high';
  goals?: string[];
}

export interface ISleep {
  schedule?: string; // e.g. '11pm–7am'
  quality?: 'poor' | 'fair' | 'good' | 'excellent';
  issues?: string[]; // e.g. ['insomnia', 'snoring']
}

export interface ILifestyle {
  stressLevel?: 'low' | 'moderate' | 'high' | 'very_high';
  workType?: 'sedentary' | 'light' | 'moderate' | 'active'; // physical demand of job
  alcohol?: 'none' | 'occasional' | 'moderate' | 'heavy';
  smoking?: 'never' | 'former' | 'current';
}

export interface IGoals {
  primary?: string[];
}

// ─── Change history entry ──────────────────────────────────────────────────

export interface IChangeEntry {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: 'user_input';
  timestamp: Date;
}

// ─── Root document ─────────────────────────────────────────────────────────

export interface IHealthProfile extends Document {
  userId: Types.ObjectId;
  body: IBody;
  diet: IDiet;
  exercise: IExercise;
  sleep: ISleep;
  lifestyle: ILifestyle;
  goals: IGoals;
  changeHistory: IChangeEntry[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const BodySchema = new Schema<IBody>(
  {
    height: { type: Number },
    weight: { type: Number },
    age: { type: Number },
    sex: { type: String, enum: ['male', 'female', 'other', 'prefer_not_to_say'] },
    bodyCompositionGoals: { type: String },
  },
  { _id: false }
);

const DietSchema = new Schema<IDiet>(
  {
    preferences: [{ type: String }],
    allergies: [{ type: String }],
    intolerances: [{ type: String }],
    dietType: { type: String },
  },
  { _id: false }
);

const ExerciseSchema = new Schema<IExercise>(
  {
    type: [{ type: String }],
    frequency: { type: String },
    intensity: { type: String, enum: ['low', 'moderate', 'high'] },
    goals: [{ type: String }],
  },
  { _id: false }
);

const SleepSchema = new Schema<ISleep>(
  {
    schedule: { type: String },
    quality: { type: String, enum: ['poor', 'fair', 'good', 'excellent'] },
    issues: [{ type: String }],
  },
  { _id: false }
);

const LifestyleSchema = new Schema<ILifestyle>(
  {
    stressLevel: { type: String, enum: ['low', 'moderate', 'high', 'very_high'] },
    workType: { type: String, enum: ['sedentary', 'light', 'moderate', 'active'] },
    alcohol: { type: String, enum: ['none', 'occasional', 'moderate', 'heavy'] },
    smoking: { type: String, enum: ['never', 'former', 'current'] },
  },
  { _id: false }
);

const GoalsSchema = new Schema<IGoals>(
  {
    primary: [{ type: String }],
  },
  { _id: false }
);

const ChangeEntrySchema = new Schema<IChangeEntry>(
  {
    field: { type: String, required: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    source: { type: String, enum: ['user_input'], default: 'user_input', required: true },
    timestamp: { type: Date, default: Date.now, required: true },
  },
  { _id: false }
);

const HealthProfileSchema = new Schema<IHealthProfile>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    body: { type: BodySchema, default: () => ({}) },
    diet: { type: DietSchema, default: () => ({}) },
    exercise: { type: ExerciseSchema, default: () => ({}) },
    sleep: { type: SleepSchema, default: () => ({}) },
    lifestyle: { type: LifestyleSchema, default: () => ({}) },
    goals: { type: GoalsSchema, default: () => ({}) },
    changeHistory: { type: [ChangeEntrySchema], default: [] },
  },
  { timestamps: true }
);

export const HealthProfile = mongoose.model<IHealthProfile>('HealthProfile', HealthProfileSchema);
