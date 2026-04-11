import { Schema, model, Document, Types } from 'mongoose';

export interface IInsightCache extends Document {
  userId: Types.ObjectId;
  type: string;
  content: string;
  generatedAt: Date;
}

const InsightCacheSchema = new Schema<IInsightCache>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    content: { type: String, required: true },
    generatedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

InsightCacheSchema.index({ userId: 1, type: 1 }, { unique: true });

export const InsightCache = model<IInsightCache>('InsightCache', InsightCacheSchema);
