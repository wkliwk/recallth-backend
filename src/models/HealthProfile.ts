import mongoose, { Document, Schema, Types } from 'mongoose';

// ─── Sub-document interfaces ───────────────────────────────────────────────

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

export interface IBody {
  height?: number; // cm
  weight?: number; // kg
  age?: number;
  sex?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  activityLevel?: ActivityLevel;
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

export interface IGoalItem {
  name: string;
  emoji?: string;
  notes?: string;
}

export interface IGoals {
  primary?: Array<string | IGoalItem>;
}

export interface ITrainingGoal {
  description: string;
  targetMetric?: string;
  targetValue?: number;
  targetUnit?: string;
  createdAt: Date;
}

export interface ISportsBackground {
  sport: string;
  experience?: string;
  status: 'active' | 'learning' | 'past';
}

export interface IInjury {
  name: string;
  location?: string;
  onsetDate?: string;
  status: 'active' | 'recovering' | 'resolved';
  notes?: string;
  lastCheckedAt?: Date;
}

export interface IBloodwork {
  hba1c?: number;         // %
  totalCholesterol?: number; // mmol/L
  ldl?: number;           // mmol/L
  hdl?: number;           // mmol/L
  triglycerides?: number; // mmol/L
  fastingGlucose?: number; // mmol/L
  ferritin?: number;      // ng/mL
  vitaminD?: number;      // nmol/L
  vitaminB12?: number;    // pmol/L
  tsh?: number;           // mIU/L
  testedAt?: string;      // date string e.g. "2026-03-01"
}

// ─── Change history entry ──────────────────────────────────────────────────

export interface IChangeEntry {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  source: 'user_input' | 'ai_extracted';
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
  bloodwork: IBloodwork;
  trainingGoals: ITrainingGoal[];
  focusAreas: string[];
  sportsBackground: ISportsBackground[];
  injuries: IInjury[];
  freeformNotes: string;
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
    activityLevel: { type: String, enum: ['sedentary', 'light', 'moderate', 'active', 'very_active'] },
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
    primary: [{ type: mongoose.Schema.Types.Mixed }],
  },
  { _id: false }
);

const BloodworkSchema = new Schema<IBloodwork>(
  {
    hba1c: { type: Number },
    totalCholesterol: { type: Number },
    ldl: { type: Number },
    hdl: { type: Number },
    triglycerides: { type: Number },
    fastingGlucose: { type: Number },
    ferritin: { type: Number },
    vitaminD: { type: Number },
    vitaminB12: { type: Number },
    tsh: { type: Number },
    testedAt: { type: String },
  },
  { _id: false }
);

const TrainingGoalSchema = new Schema<ITrainingGoal>(
  {
    description: { type: String, required: true },
    targetMetric: { type: String },
    targetValue: { type: Number },
    targetUnit: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SportsBackgroundSchema = new Schema<ISportsBackground>(
  {
    sport: { type: String, required: true },
    experience: { type: String },
    status: { type: String, enum: ['active', 'learning', 'past'], default: 'active' },
  },
  { _id: false }
);

const InjurySchema = new Schema<IInjury>(
  {
    name: { type: String, required: true },
    location: { type: String },
    onsetDate: { type: String },
    status: { type: String, enum: ['active', 'recovering', 'resolved'], default: 'active' },
    notes: { type: String },
    lastCheckedAt: { type: Date },
  },
  { _id: false }
);

const ChangeEntrySchema = new Schema<IChangeEntry>(
  {
    field: { type: String, required: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    source: { type: String, enum: ['user_input', 'ai_extracted'], default: 'user_input', required: true },
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
    bloodwork: { type: BloodworkSchema, default: () => ({}) },
    trainingGoals: { type: [TrainingGoalSchema], default: [] },
    focusAreas: { type: [String], default: [] },
    sportsBackground: { type: [SportsBackgroundSchema], default: [] },
    injuries: { type: [InjurySchema], default: [] },
    freeformNotes: { type: String, default: '' },
    changeHistory: { type: [ChangeEntrySchema], default: [] },
  },
  { timestamps: true }
);

export const HealthProfile = mongoose.model<IHealthProfile>('HealthProfile', HealthProfileSchema);
