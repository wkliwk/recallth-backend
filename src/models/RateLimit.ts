import { Schema, model, Document } from 'mongoose';

export interface IRateLimit extends Document {
  userId: string;
  windowStart: Date;
  count: number;
}

const RateLimitSchema = new Schema<IRateLimit>(
  {
    userId: { type: String, required: true, index: true },
    windowStart: { type: Date, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { timestamps: false }
);

// TTL index — MongoDB auto-deletes documents 1 hour after windowStart
RateLimitSchema.index({ windowStart: 1 }, { expireAfterSeconds: 3600 });

export const RateLimit = model<IRateLimit>('RateLimit', RateLimitSchema);
