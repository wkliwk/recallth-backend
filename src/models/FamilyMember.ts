import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IFamilyMember extends Document {
  ownerId: Types.ObjectId;   // the primary user who owns this family member entry
  name: string;
  relationship?: string;     // e.g. 'Mum', 'Dad', 'Child', 'Partner'
  createdAt: Date;
  updatedAt: Date;
}

const FamilyMemberSchema = new Schema<IFamilyMember>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    relationship: { type: String, trim: true },
  },
  { timestamps: true }
);

export const FamilyMember = mongoose.model<IFamilyMember>('FamilyMember', FamilyMemberSchema);
