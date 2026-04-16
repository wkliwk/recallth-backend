import { Schema, model, Document, Types } from 'mongoose';

export type MessageRole = 'user' | 'assistant';

export interface IMessageAction {
  type: 'save_profile' | 'add_cabinet';
  label: string;
  data: Record<string, unknown>;
  applied?: boolean;
}

export interface IMessage {
  role: MessageRole;
  content: string;
  timestamp: Date;
  actions?: IMessageAction[];
}

export interface IConversation extends Document {
  userId: Types.ObjectId;
  title: string;
  summary: string;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const ActionSchema = new Schema(
  {
    type: { type: String, enum: ['save_profile', 'add_cabinet'], required: true },
    label: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    applied: { type: Boolean, default: false },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    actions: { type: [ActionSchema], default: undefined },
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
