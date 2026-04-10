import { GoogleGenerativeAI } from '@google/generative-ai';
import { Types } from 'mongoose';
import { HealthProfile, IHealthProfile } from '../models/HealthProfile';
import { CabinetItem, ICabinetItem } from '../models/CabinetItem';
import { ExtractionReview } from '../models/ExtractionReview';
import { Conversation } from '../models/Conversation';
import { DailyLog, IDailyLog } from '../models/DailyLog';
import { SideEffect, ISideEffect } from '../models/SideEffect';
import { detectLanguage, DetectedLanguage } from '../utils/language';
import { MODELS } from '../config/models';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

// --- Rate limiting ---
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function checkRateLimit(userId: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now >= entry.resetAt) {
    const newEntry: RateLimitEntry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(userId, newEntry);
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1, resetAt: newEntry.resetAt };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: RATE_LIMIT_MAX - entry.count, resetAt: entry.resetAt };
}

// --- Language instruction builder ---
function buildLanguageInstruction(language: DetectedLanguage): string {
  switch (language) {
    case 'zh-HK':
      return `LANGUAGE: The user is writing in Cantonese (廣東話). You MUST respond entirely in Cantonese (廣東話). Use natural conversational Cantonese, not formal Mandarin. Use Cantonese particles like 係、唔、嘅、喺、啩、囉 etc.`;
    case 'zh-TW':
      return `LANGUAGE: The user is writing in Traditional Chinese (繁體中文). You MUST respond entirely in Traditional Chinese. Use proper Traditional Chinese characters (not Simplified).`;
    case 'en':
    default:
      return `LANGUAGE: Respond in English.`;
  }
}

// --- Journal and side-effect context builders ---
function buildJournalContext(logs: IDailyLog[]): string {
  if (logs.length === 0) return '';
  const avgMood = (logs.reduce((sum, l) => sum + l.mood, 0) / logs.length).toFixed(1);
  const avgEnergy = (logs.reduce((sum, l) => sum + l.energy, 0) / logs.length).toFixed(1);
  const entries = logs.map((l) => {
    const noteStr = l.notes ? ` Notes: "${l.notes.slice(0, 100)}"` : '';
    return `  ${l.date}: mood=${l.mood}/5, energy=${l.energy}/5${noteStr}`;
  });
  // ~300 tokens estimated for 7 entries
  return `\nRECENT JOURNAL SUMMARY (last 7 days, avg mood=${avgMood}/5, avg energy=${avgEnergy}/5):\n${entries.join('\n')}`;
}

function buildSideEffectContext(effects: ISideEffect[]): string {
  if (effects.length === 0) return '';
  const entries = effects.map((e) => {
    const date = e.date instanceof Date ? e.date.toISOString().slice(0, 10) : String(e.date);
    return `  ${date}: symptom="${e.symptom}", severity=${e.rating}/5`;
  });
  // ~250 tokens estimated for 10 entries
  return `\nRECENT SIDE EFFECTS (last 30 days):\n${entries.join('\n')}`;
}

// --- System prompt builder ---
function buildSystemPrompt(
  profile: IHealthProfile | null,
  cabinetItems: ICabinetItem[],
  language: DetectedLanguage,
  journalLogs: IDailyLog[],
  sideEffects: ISideEffect[]
): string {
  const profileData = profile
    ? {
        body: profile.body,
        diet: profile.diet,
        exercise: profile.exercise,
        sleep: profile.sleep,
        lifestyle: profile.lifestyle,
        goals: profile.goals,
        bloodwork: profile.bloodwork,
      }
    : null;

  const cabinetData = cabinetItems.map((item) => ({
    name: item.name,
    type: item.type,
    dosage: item.dosage,
    frequency: item.frequency,
    timing: item.timing,
    brand: item.brand,
  }));

  const languageInstruction = buildLanguageInstruction(language);
  const journalContext = buildJournalContext(journalLogs);
  const sideEffectContext = buildSideEffectContext(sideEffects);

  return `You are Recallth, a personal AI health advisor with perfect memory of this user's health profile.

USER HEALTH PROFILE:
${JSON.stringify(profileData, null, 2)}

CURRENT SUPPLEMENT & MEDICATION CABINET:
${JSON.stringify(cabinetData, null, 2)}
${journalContext}${sideEffectContext}

${languageInstruction}

LANGUAGE RULES:
- Detect the language of the user's message
- Always respond in the SAME language the user writes in
- If user writes in 廣東話 (Cantonese), respond in 廣東話 with traditional characters
- If user writes in 繁體中文, respond in 繁體中文
- If user writes in English, respond in English
- Never mix languages in a single response unless the user does

INSTRUCTIONS:
- Always personalise responses using the user's actual data above
- Reference specific values (e.g. "given your 400mg magnesium intake...")
- If a profile field is empty/missing, do NOT assume or invent values
- Be warm, helpful, and direct — like a knowledgeable friend, not a clinical report
- If asked about something outside health/wellness, politely redirect

PROACTIVE INSIGHTS (optional — do this roughly 1 in every 3 responses):
- After answering the user's question, you MAY add a brief proactive insight on a new line
- The insight should be something the user hasn't asked about but that you notice from their profile or cabinet
- Examples: a supplement timing optimisation, a goal alignment observation, a potential gap in their stack
- Label it clearly so the user knows it's unsolicited: prefix with "💡 Insight:" (English), "💡 洞察：" (廣東話 / 繁體中文)
- Keep it to 1–2 sentences. Never repeat an insight from earlier in this conversation.
- Only include an insight when it's genuinely useful. Skip it if nothing meaningful comes to mind.

DISCLAIMER (append to every response in the correct language on a new line):
- English: "⚠️ This is not medical advice. Consult a healthcare professional for medical decisions."
- 廣東話: "⚠️ 以上內容並非醫療建議。如有醫療需要，請諮詢專業醫護人員。"
- 繁體中文: "⚠️ 以上內容僅供參考，並非醫療建議。請諮詢專業醫療人員。"`;
}

// --- Extraction types ---
interface ExtractedBody {
  height?: number | null;
  weight?: number | null;
  age?: number | null;
  sex?: string | null;
}

interface ExtractedDiet {
  allergies?: string[] | null;
  dietType?: string | null;
}

interface ExtractedExercise {
  frequency?: string | null;
  type?: string | null;
  goals?: string | null;
}

interface ExtractedSleep {
  schedule?: string | null;
  quality?: string | null;
}

interface ExtractedLifestyle {
  stressLevel?: string | null;
  alcohol?: string | null;
  smoking?: string | null;
}

interface ExtractedGoals {
  primary?: string | null;
}

interface ExtractedCabinetItem {
  name?: string | null;
  dosage?: string | null;
  frequency?: string | null;
  timing?: string | null;
  brand?: string | null;
}

interface ExtractionResult {
  body?: ExtractedBody;
  diet?: ExtractedDiet;
  exercise?: ExtractedExercise;
  sleep?: ExtractedSleep;
  lifestyle?: ExtractedLifestyle;
  goals?: ExtractedGoals;
  cabinetItems?: ExtractedCabinetItem[];
}

// --- Profile extraction ---
async function extractHealthData(userMessage: string): Promise<ExtractionResult | null> {
  const extractionPrompt = `Extract any health profile data from this user message. The message may be in English, Cantonese (廣東話), or Traditional Chinese (繁體中文). Return ONLY valid JSON or null.

Cantonese/Chinese interpretation hints:
- "食緊" / "正在服用" / "有食" = currently taking (supplement or medication)
- "我185cm 78kg" = height 185cm, weight 78kg
- "每星期...三次" = frequency three times per week
- "做gym" / "做運動" = exercise/gym
- "我食緊creatine同magnesium" = cabinet items: creatine and magnesium

User message: ${userMessage}

Extract these fields if mentioned (use null for anything not mentioned):
{
  "body": { "height": null, "weight": null, "age": null, "sex": null },
  "diet": { "allergies": null, "dietType": null },
  "exercise": { "frequency": null, "type": null, "goals": null },
  "sleep": { "schedule": null, "quality": null },
  "lifestyle": { "stressLevel": null, "alcohol": null, "smoking": null },
  "goals": { "primary": null },
  "cabinetItems": [{ "name": null, "dosage": null, "frequency": null, "timing": null, "brand": null }]
}

Only include fields explicitly stated. Return null if nothing to extract. Respond only with JSON.`;

  const model = getGenAI().getGenerativeModel({ model: MODELS.EXTRACTION });
  const result = await model.generateContent(extractionPrompt);
  const text = result.response.text().trim();

  const usage = result.response.usageMetadata;
  console.log(
    `[AI] model=${MODELS.EXTRACTION} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=extraction`
  );

  if (!text || text === 'null') return null;

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed: ExtractionResult = JSON.parse(cleaned) as ExtractionResult;
    return parsed;
  } catch {
    return null;
  }
}

// --- Apply extraction to DB ---
async function applyExtractedData(
  userId: Types.ObjectId,
  extracted: ExtractionResult
): Promise<void> {
  // Build dot-notation $set for profile fields
  const profileSet: Record<string, unknown> = { source: 'ai_extracted' };
  const profileReviews: Array<{
    field: string;
    extractedValue: unknown;
  }> = [];

  const profileCategories: Array<keyof Omit<ExtractionResult, 'cabinetItems'>> = [
    'body', 'diet', 'exercise', 'sleep', 'lifestyle', 'goals',
  ];

  for (const category of profileCategories) {
    const categoryData = extracted[category] as Record<string, unknown> | undefined;
    if (!categoryData) continue;

    for (const [field, value] of Object.entries(categoryData)) {
      if (value !== null && value !== undefined) {
        const dotField = `${category}.${field}`;
        profileSet[dotField] = value;
        profileReviews.push({ field: dotField, extractedValue: value });
      }
    }
  }

  if (Object.keys(profileSet).length > 1) {
    // Capture old values for change history before updating
    const existing = await HealthProfile.findOne({ userId }, { body: 1 }).lean();

    await HealthProfile.findOneAndUpdate(
      { userId },
      {
        $set: profileSet,
        $push: {
          changeHistory: {
            $each: profileReviews.map((r) => ({
              field: r.field,
              oldValue: existing ? (existing as unknown as Record<string, unknown>)[r.field.split('.')[0]] : null,
              newValue: r.extractedValue,
              source: 'ai_extracted' as const,
              timestamp: new Date(),
            })),
          },
        },
      },
      { upsert: true, new: true }
    );

    // Create ExtractionReview records for profile fields
    for (const review of profileReviews) {
      await ExtractionReview.create({
        userId,
        source: 'profile',
        field: review.field,
        extractedValue: review.extractedValue,
        status: 'pending',
        extractedAt: new Date(),
      });
    }
  }

  // Create cabinet items for any new supplements mentioned
  if (extracted.cabinetItems && extracted.cabinetItems.length > 0) {
    for (const item of extracted.cabinetItems) {
      if (item.name) {
        const cabinetItem = await CabinetItem.create({
          userId,
          name: item.name,
          dosage: item.dosage ?? undefined,
          frequency: item.frequency ?? undefined,
          timing: item.timing ?? undefined,
          brand: item.brand ?? undefined,
          source: 'ai_extracted',
          active: true,
        });

        // Create ExtractionReview records for cabinet item fields
        const cabinetFields = ['dosage', 'frequency', 'timing', 'brand'];
        for (const field of cabinetFields) {
          const value = (item as Record<string, unknown>)[field];
          if (value !== null && value !== undefined) {
            await ExtractionReview.create({
              userId,
              source: 'cabinet',
              sourceId: cabinetItem._id,
              field,
              extractedValue: value,
              status: 'pending',
              extractedAt: new Date(),
            });
          }
        }
      }
    }
  }
}

// --- Generate title from first message ---
function generateTitle(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 50) return trimmed;
  return trimmed.slice(0, 47) + '...';
}

// --- Main chat function ---
export interface ChatResult {
  conversationId: string;
  message: {
    role: 'assistant';
    content: string;
    timestamp: Date;
  };
  extractedData: ExtractionResult | null;
  detectedLanguage: DetectedLanguage;
}

export async function processChat(
  userId: string,
  userMessage: string,
  conversationId?: string
): Promise<ChatResult> {
  const userObjectId = new Types.ObjectId(userId);

  // Detect language from user message
  const language = detectLanguage(userMessage);

  // Load profile, cabinet, journal, and side effects in parallel
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISO = sevenDaysAgo.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [profile, cabinetItems, journalLogs, sideEffects] = await Promise.all([
    HealthProfile.findOne({ userId: userObjectId }),
    CabinetItem.find({ userId: userObjectId, active: true }),
    DailyLog.find({ userId: userObjectId, date: { $gte: sevenDaysAgoISO } }).sort({ date: -1 }).limit(7),
    SideEffect.find({ userId: userObjectId, date: { $gte: thirtyDaysAgo } }).sort({ date: -1 }).limit(10),
  ]);

  // Fetch or create conversation
  let conversation;
  if (conversationId) {
    conversation = await Conversation.findOne({
      _id: new Types.ObjectId(conversationId),
      userId: userObjectId,
    });
    if (!conversation) {
      const err = new Error('Conversation not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
  } else {
    conversation = await Conversation.create({
      userId: userObjectId,
      title: generateTitle(userMessage),
      messages: [],
    });
  }

  // Append user message
  const userMsg = { role: 'user' as const, content: userMessage, timestamp: new Date() };
  conversation.messages.push(userMsg);

  // Build message history for Gemini (last 20 messages for context window, excluding the latest user message)
  const allMessages = conversation.messages.slice(-20);
  // History is all messages except the last user message (which we send via sendMessage)
  const historyMessages = allMessages.slice(0, -1);
  const history = historyMessages.map((m) => ({
    role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
    parts: [{ text: m.content }],
  }));

  // Call Gemini for chat response
  const systemPrompt = buildSystemPrompt(profile, cabinetItems, language, journalLogs, sideEffects);
  const model = getGenAI().getGenerativeModel({
    model: MODELS.CHAT,
    systemInstruction: systemPrompt,
  });

  const chat = model.startChat({ history });
  const chatResult = await chat.sendMessage(userMessage);
  const assistantContent = chatResult.response.text();

  const usage = chatResult.response.usageMetadata;
  console.log(
    `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=chat`
  );

  const assistantMsg = {
    role: 'assistant' as const,
    content: assistantContent,
    timestamp: new Date(),
  };
  conversation.messages.push(assistantMsg);
  await conversation.save();

  // Run extraction in parallel (non-blocking on response, but we await to include in response)
  let extractedData: ExtractionResult | null = null;
  try {
    extractedData = await extractHealthData(userMessage);
    if (extractedData) {
      await applyExtractedData(userObjectId, extractedData);
    }
  } catch (err) {
    // Extraction failure should not break the chat response
    console.error('[Chat] Extraction error:', err);
  }

  return {
    conversationId: String(conversation._id),
    message: assistantMsg,
    extractedData,
    detectedLanguage: language,
  };
}
