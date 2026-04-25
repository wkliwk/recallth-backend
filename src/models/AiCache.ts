import { Schema, model, Document } from 'mongoose';

export interface IAiCache extends Document {
  type: string;
  key: string;
  result: unknown;
  createdAt: Date;
}

const AiCacheSchema = new Schema<IAiCache>(
  {
    type: { type: String, required: true },
    key:  { type: String, required: true },
    result: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound unique index so upsert works cleanly
AiCacheSchema.index({ type: 1, key: 1 }, { unique: true });

// TTL: expire documents 24 hours after creation
AiCacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const AiCache = model<IAiCache>('AiCache', AiCacheSchema);

export async function getCached<T>(type: string, key: string): Promise<T | null> {
  const doc = await AiCache.findOne({ type, key }).lean();
  return doc ? (doc.result as T) : null;
}

export async function setCached<T>(type: string, key: string, result: T): Promise<void> {
  await AiCache.findOneAndUpdate(
    { type, key },
    { $set: { result, createdAt: new Date() } },
    { upsert: true }
  );
}

export async function deleteCached(type: string, keyPattern: string): Promise<void> {
  await AiCache.deleteMany({ type, key: new RegExp(keyPattern, 'i') });
}
