import { Schema, model, Document, Types } from 'mongoose';

export interface IUserSettings extends Document {
  userId: Types.ObjectId;
  remindersEnabled: boolean;
  reminderTimes: string[]; // e.g. ["08:00", "21:00"]
  timezone: string; // IANA tz string
  emailDigestEnabled: boolean;
  emailDigestDay: string; // e.g. "sunday"
  communityContributeEnabled: boolean; // opt-out of contributing to community food DB
  createdAt: Date;
  updatedAt: Date;
}

const UserSettingsSchema = new Schema<IUserSettings>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    remindersEnabled: { type: Boolean, default: false },
    reminderTimes: { type: [String], default: [] },
    timezone: { type: String, default: 'UTC' },
    emailDigestEnabled: { type: Boolean, default: false },
    emailDigestDay: { type: String, default: 'sunday' },
    communityContributeEnabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const UserSettings = model<IUserSettings>('UserSettings', UserSettingsSchema);
