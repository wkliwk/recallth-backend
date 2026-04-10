import { Schema, model, Document, Types } from 'mongoose';

export type MessageRole = 'user' | 'assistant';

export interface IMessage {
  role: MessageRole;
  content: string;
  timestamp: Date;
}

export interface IConversation extends Document {
  userId: Types.ObjectId;
  title: string;
  summary: string;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, default: 'New Conversation' },
    summary: { type: String, default: '' },
    messages: [MessageSchema],
  },
  { timestamps: true }
);

ConversationSchema.index({ userId: 1, createdAt: -1 });

export const Conversation = model<IConversation>('Conversation', ConversationSchema);
