import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISharedStack extends Document {
  token: string;
  userId: Types.ObjectId;
  createdAt: Date;
}

const SharedStackSchema = new Schema<ISharedStack>(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const SharedStack = mongoose.model<ISharedStack>('SharedStack', SharedStackSchema);
