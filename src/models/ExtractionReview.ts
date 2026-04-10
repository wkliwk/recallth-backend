import mongoose, { Document, Schema, Types } from 'mongoose';

export type ExtractionSource = 'profile' | 'cabinet';
export type ReviewStatus = 'pending' | 'confirmed' | 'corrected' | 'rejected';

export interface IExtractionReview extends Document {
  userId: Types.ObjectId;
  source: ExtractionSource;
  sourceId?: Types.ObjectId; // for cabinet items
  field: string; // e.g. 'body.weight', 'cabinet.Creatine'
  extractedValue: unknown;
  status: ReviewStatus;
  correctedValue?: unknown;
  extractedAt: Date;
  reviewedAt?: Date;
  conversationId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ExtractionReviewSchema = new Schema<IExtractionReview>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['profile', 'cabinet'],
      required: true,
    },
    sourceId: {
      type: Schema.Types.ObjectId,
    },
    field: {
      type: String,
      required: true,
    },
    extractedValue: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'corrected', 'rejected'],
      default: 'pending',
      index: true,
    },
    correctedValue: {
      type: Schema.Types.Mixed,
    },
    extractedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    reviewedAt: {
      type: Date,
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
    },
  },
  { timestamps: true }
);

// Index for efficient querying of pending reviews by user
ExtractionReviewSchema.index({ userId: 1, status: 1 });

export const ExtractionReview = mongoose.model<IExtractionReview>(
  'ExtractionReview',
  ExtractionReviewSchema
);
