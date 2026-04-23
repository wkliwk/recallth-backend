import { Schema, model, Document, Types } from 'mongoose';

export interface ExerciseSet {
  name: string;
  type?: 'strength' | 'bodyweight' | 'timed' | 'cardio' | 'session';
  // strength / bodyweight fields
  sets?: number;
  reps?: number;
  weightKg?: number;       // required for strength; optional for bodyweight
  // timed fields
  durationMin?: number;    // used by timed (sets × duration) and session (duration only)
  // cardio fields
  distanceKm?: number;
}

export interface IExerciseSession extends Document {
  userId: Types.ObjectId;
  status: 'planned' | 'completed';
  activityType: string;
  activityLabel?: string;
  date: string;
  durationMinutes: number;
  intensity: 'easy' | 'moderate' | 'hard';
  distanceKm?: number;
  exercises?: ExerciseSet[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExerciseSetSchema = new Schema<ExerciseSet>(
  {
    name: { type: String, required: true, trim: true },
    // 'stretch' and 'hiit' kept in enum for backwards compat with existing DB documents
    type: { type: String, enum: ['strength', 'bodyweight', 'timed', 'cardio', 'session', 'stretch', 'hiit'], default: 'strength' },
    sets: { type: Number },
    reps: { type: Number },
    weightKg: { type: Number },
    durationMin: { type: Number },
    distanceKm: { type: Number },
  },
  { _id: false },
);

const ExerciseSessionSchema = new Schema<IExerciseSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['planned', 'completed'], default: 'completed' },
    activityType: { type: String, required: true, trim: true },
    activityLabel: { type: String, trim: true },
    date: { type: String, required: true },
    durationMinutes: { type: Number, required: true },
    intensity: { type: String, enum: ['easy', 'moderate', 'hard'], required: true },
    distanceKm: { type: Number },
    exercises: { type: [ExerciseSetSchema], default: undefined },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

ExerciseSessionSchema.index({ userId: 1, date: -1 });

export const ExerciseSession = model<IExerciseSession>('ExerciseSession', ExerciseSessionSchema);
