import { Schema, model, Document, Types } from 'mongoose';

export interface ExerciseSet {
  name: string;
  type?: 'strength' | 'cardio' | 'stretch' | 'hiit';
  // strength fields
  sets?: number;
  reps?: number;
  weightKg?: number;
  // cardio / stretch fields
  durationMin?: number;
  distanceKm?: number;
  // hiit fields
  rounds?: number;
}

export interface IExerciseSession extends Document {
  userId: Types.ObjectId;
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
    type: { type: String, enum: ['strength', 'cardio', 'stretch', 'hiit'], default: 'strength' },
    sets: { type: Number },
    reps: { type: Number },
    weightKg: { type: Number },
    durationMin: { type: Number },
    distanceKm: { type: Number },
    rounds: { type: Number },
  },
  { _id: false },
);

const ExerciseSessionSchema = new Schema<IExerciseSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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
