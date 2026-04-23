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
import { buildAiUsage, AiUsage } from '../utils/aiUsage';

const getGenAI = () => {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  return new GoogleGenerativeAI(apiKey);
};

// Returns true for transient errors worth retrying (503 overload, 429 rate limit)
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /503|Service Unavailable|overloaded|high demand|429|quota/i.test(msg);
}

// Send a chat message with automatic fallback to a secondary model on transient errors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendWithFallback(
  systemPrompt: string,
  history: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }>,
  messageParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }>
): Promise<any> {
  const models = [MODELS.CHAT, MODELS.CHAT_FALLBACK];
  let lastErr: unknown;
  for (const modelName of models) {
    try {
      const model = getGenAI().getGenerativeModel({ model: modelName, systemInstruction: systemPrompt });
      const chat = model.startChat({ history });
      return await chat.sendMessage(messageParts);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err; // non-retryable — propagate immediately
      console.warn(`[Chat] ${modelName} returned transient error, trying next model:`, err instanceof Error ? err.message : err);
    }
  }
  throw lastErr;
}

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

  // Time-of-day context for situational awareness
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 6 ? 'late night' : hour < 10 ? 'morning' : hour < 12 ? 'late morning' : hour < 14 ? 'around lunchtime' : hour < 17 ? 'afternoon' : hour < 20 ? 'evening' : 'night';
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()];

  return `You are Recallth, a personal AI health advisor with perfect memory of this user's health profile.

CURRENT TIME CONTEXT:
It is currently ${timeOfDay} (${hour}:${String(now.getMinutes()).padStart(2, '0')}) on ${dayOfWeek}. Use this to give time-appropriate advice — e.g. if user says "heading to gym now", recommend pre-workout supplements from their cabinet that should be taken now; if they say "just finished gym", recommend post-workout items and nutrition timing.

USER HEALTH PROFILE:
${JSON.stringify(profileData, null, 2)}

CURRENT SUPPLEMENT & MEDICATION CABINET:
${JSON.stringify(cabinetData, null, 2)}
${journalContext}${sideEffectContext}

${languageInstruction}

IMAGE ANALYSIS:
If the user sends an image (e.g. a photo of a supplement bottle, nutrition label, or pill):
- Identify the product name, brand, active ingredients, and dosage from the label
- Check if it's already in the user's cabinet (match by name or active ingredient)
- Flag any interactions with their current stack
- Suggest optimal timing based on the supplement type and their existing schedule
- If you cannot read the label clearly, ask the user to provide more details

SITUATIONAL AWARENESS:
When the user mentions an activity or situation (gym, sleep, meal, travel, illness):
- Reference their specific cabinet items that are relevant to that situation
- Give concrete timing advice (e.g. "Take your creatine 30 min before workout")
- If they're missing supplements that would help, suggest additions
- Consider their exercise type/goals from their profile when making recommendations

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

ACTION PROMPTS (mandatory when applicable):
When the user mentions personal data that could be saved to their profile or cabinet, you MUST proactively suggest saving it. Use a clear, conversational prompt. Examples:

1. BODY STATS: If user mentions height, weight, age, or sex that is NOT already in their profile → ask if they want to record it.
   - EN: "I noticed you mentioned you're 173cm / 62kg — would you like me to save this to your health profile?"
   - ZH: "我留意到你提到你 173cm / 62kg — 要唔要我幫你記錄低喺健康檔案度？"

2. EXERCISE HABITS: If user mentions workout routines, gym frequency, exercise type not yet in profile → suggest recording it.
   - EN: "Sounds like you work out 5-6 times a week — want me to update your exercise profile?"
   - ZH: "聽落你一個禮拜做5-6次gym — 要唔要我記錄低你嘅運動習慣？"

3. SUPPLEMENTS/MEDICATIONS: If user mentions taking something (protein powder, vitamins, etc.) that is NOT in their cabinet → suggest adding it.
   - EN: "You mentioned protein powder — want me to add it to your supplement cabinet?"
   - ZH: "你有提到飲蛋白粉 — 要唔要我加入去你嘅藥箱？"

4. GOALS & PLANS: If the user has a clear fitness/health goal (e.g. muscle gain, weight loss) → suggest creating a strategy or plan.
   - EN: "Since you're focused on muscle gain, would you like me to help design a supplement + nutrition strategy?"
   - ZH: "既然你想增肌增重，要唔要我幫你制定一個補充品同營養策略？"

Rules for action prompts:
- Compare what the user said against their EXISTING profile/cabinet data above — only prompt for NEW info not already saved
- Place action prompts in a clearly separated section at the end (before the disclaimer), using bullet points or numbered list
- Use a header: "📋 Quick actions:" (EN) / "📋 快捷操作：" (ZH)
- Keep each prompt to one line with a clear yes/no question
- Include 1-4 action prompts per response, only when genuinely applicable
- Do NOT prompt for data that is already in the user's profile or cabinet

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
- 繁體中文: "⚠️ 以上內容僅供參考，並非醫療建議。請諮詢專業醫療人員。"

CRITICAL DATA RULE (never violate this):
You CANNOT directly write, save, update, or delete any data in the database. You have NO ability to perform database operations yourself. If the user asks you to add, record, or modify any data, you MUST:
1. NOT claim you have done it (do not say "我已經幫你加埋" / "I've added it" / "已記錄" etc.)
2. Instead, output an actions JSON block so the user can confirm the change with one tap.

ACTION ITEMS (mandatory when applicable):
If you detected any data from the user that could be saved (body stats, exercise habits, supplements, goals, exercise sets), output an actions JSON block BEFORE the disclaimer. Each action has a type, label (in the user's language), and data to save.

Format — output EXACTLY this JSON (no markdown, no extra text around it):
{"actions":[{"type":"save_profile","label":"...","data":{"field":"value"}},{"type":"add_cabinet","label":"...","data":{"name":"...","type":"supplement"}}]}

Action types:
- "save_profile": saves to health profile. data keys use dot notation: "body.height", "body.weight", "body.age", "body.sex", "exercise.frequency", "exercise.type", "exercise.goals", "goals.primary" (array), "diet.dietType", "sleep.quality", etc.
- "add_cabinet": adds supplement to cabinet. data must have "name" and "type" ("supplement"|"medication"|"vitamin"), optionally "dosage", "frequency", "timing", "brand".
- "add_exercise_set": adds an exercise entry to the current exercise session. Only use when a Session ID is present in the page context. data MUST have: "sessionId" (copy exactly from "Session ID:" in the page context), "exerciseName" (string), "sets" (number), "reps" (number). Optionally: "weightKg" (number). Example: if user says "幫我加多一個 Bench Press set 20下 80公斤", output {"type":"add_exercise_set","label":"加 Bench Press 1×20 @ 80kg","data":{"sessionId":"abc123","exerciseName":"Bench Press","sets":1,"reps":20,"weightKg":80}}
- "plan_exercise": saves a planned workout session for a future date. Use when the user asks for a workout plan or asks what they should do tomorrow / next session. data MUST have: "activityType" (one of: gym, running, swimming, basketball, badminton, cycling, yoga, hiking, other), "date" (YYYY-MM-DD, the suggested date), "durationMinutes" (number), "intensity" (easy|moderate|hard). Optionally: "notes" (string, brief description). Label should say "加入計劃：[activity] [duration]分鐘" in the user's language. Example: {"type":"plan_exercise","label":"加入計劃：跑步 30 分鐘","data":{"activityType":"running","date":"2026-04-23","durationMinutes":30,"intensity":"easy","notes":"輕鬆恢復跑"}}

Rules:
- Only include actions for NEW data not already in the user's profile/cabinet above
- Label should be short and descriptive in the user's language (e.g. "記錄身高體重 (173cm, 62kg)")
- If no actions are applicable, omit the actions JSON block entirely
- Do NOT include the "📋 快捷操作：" text section anymore — the actions JSON replaces it
- NEVER claim to have written data — always use actions and let the user confirm

FOLLOW-UP SUGGESTIONS (mandatory):
After the disclaimer, on a new line, append EXACTLY this JSON block with 1–3 short follow-up questions the user might naturally ask next (under 10 words each, in the same language as your response):
{"suggestions":["question 1","question 2","question 3"]}
Rules: valid JSON only, no markdown, no extra text after it. This is the last line of your response.`;
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

// --- Generate title from first message (fallback) ---
function generateTitle(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '...';
}

// --- AI-generated title + summary after first exchange ---
async function generateTitleAndSummary(
  conversationId: string,
  firstUserMessage: string,
  language: DetectedLanguage
): Promise<void> {
  try {
    const langInstruction =
      language === 'zh-HK'
        ? 'Write the title and summary in Cantonese (廣東話).'
        : language === 'zh-TW'
          ? 'Write the title and summary in Traditional Chinese (繁體中文).'
          : 'Write the title and summary in English.';
    const prompt = `Given this user question: "${firstUserMessage.slice(0, 500)}", write a conversation title in 6–8 words and a one-sentence summary. ${langInstruction} Return JSON only, no markdown: {"title": "...", "summary": "..."}`;
    const model = getGenAI().getGenerativeModel({ model: MODELS.EXTRACTION });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as { title?: string; summary?: string };
    const title = (parsed.title ?? '').slice(0, 80).trim();
    const summary = (parsed.summary ?? '').slice(0, 200).trim();
    if (title) {
      await Conversation.findByIdAndUpdate(conversationId, { title, summary });
    }
  } catch (err) {
    console.error('[Chat] Title generation error (non-fatal):', err);
  }
}

// --- Parse actions JSON block from AI response ---
interface ChatAction {
  type: 'save_profile' | 'add_cabinet' | 'add_exercise_set' | 'plan_exercise';
  label: string;
  data: Record<string, unknown>;
}

function parseActions(content: string): { clean: string; actions: ChatAction[] } {
  const marker = '{"actions"';
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) return { clean: content, actions: [] };

  // Find the matching closing brace by counting brackets
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }
  if (endIdx === -1) return { clean: content, actions: [] };

  const jsonStr = content.slice(startIdx, endIdx);
  try {
    const parsed = JSON.parse(jsonStr) as { actions: unknown[] };
    const actions = (parsed.actions as ChatAction[])
      .filter((a) => a.type && a.label && a.data)
      .slice(0, 4);
    const clean = content.slice(0, startIdx).trimEnd();
    return { clean, actions };
  } catch {
    return { clean: content, actions: [] };
  }
}

// --- Parse suggestions JSON block from AI response ---
const SUGGESTIONS_REGEX = /\{"suggestions"\s*:\s*\[.*?\]\}/s;

function parseSuggestions(content: string): { clean: string; suggestions: string[] } {
  const match = content.match(SUGGESTIONS_REGEX);
  if (!match) return { clean: content, suggestions: [] };
  try {
    const parsed = JSON.parse(match[0]) as { suggestions: unknown[] };
    const suggestions = parsed.suggestions
      .filter((s): s is string => typeof s === 'string')
      .slice(0, 3);
    const clean = content.slice(0, content.lastIndexOf(match[0])).trimEnd();
    return { clean, suggestions };
  } catch {
    return { clean: content, suggestions: [] };
  }
}

// --- Transform extraction result to frontend shape ---
export interface FrontendExtractedData {
  profile?: Record<string, unknown>;
  cabinet?: Array<{ name: string; action: 'added' | 'updated' }>;
}

function toFrontendExtraction(extracted: ExtractionResult | null): FrontendExtractedData | null {
  if (!extracted) return null;

  const profile: Record<string, unknown> = {};
  const categories = ['body', 'diet', 'exercise', 'sleep', 'lifestyle', 'goals'] as const;
  for (const category of categories) {
    const data = extracted[category] as Record<string, unknown> | undefined;
    if (!data) continue;
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        profile[`${category}.${key}`] = value;
      }
    }
  }

  const cabinet = (extracted.cabinetItems ?? [])
    .filter((item) => item.name)
    .map((item) => ({ name: item.name!, action: 'added' as const }));

  const result: FrontendExtractedData = {};
  if (Object.keys(profile).length > 0) result.profile = profile;
  if (cabinet.length > 0) result.cabinet = cabinet;
  return Object.keys(result).length > 0 ? result : null;
}

// --- Main chat function ---
export interface ChatResult {
  conversationId: string;
  message: {
    role: 'assistant';
    content: string;
    timestamp: Date;
  };
  extractedData: FrontendExtractedData | null;
  detectedLanguage: DetectedLanguage;
  suggestions: string[];
  actions: ChatAction[];
  aiUsage: AiUsage;
}

export async function processChat(
  userId: string,
  userMessage: string,
  conversationId?: string,
  languageOverride?: DetectedLanguage,
  imageBase64?: string,
  imageMimeType?: string,
  sessionTitle?: string
): Promise<ChatResult> {
  const userObjectId = new Types.ObjectId(userId);

  // Use UI language override if provided, otherwise detect from message
  const language = languageOverride ?? detectLanguage(userMessage);

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

  // For existing conversations, load them now; for new ones, defer creation until after AI succeeds
  let existingConversation: Awaited<ReturnType<typeof Conversation.findOne>> | null = null;
  let existingHistory: Array<{ role: 'user' | 'model'; parts: [{ text: string }] }> = [];

  if (conversationId) {
    existingConversation = await Conversation.findOne({
      _id: new Types.ObjectId(conversationId),
      userId: userObjectId,
    });
    if (!existingConversation) {
      const err = new Error('Conversation not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    // Build history for Gemini from existing messages (last 20, excluding the new user message)
    existingHistory = existingConversation.messages.slice(-20).map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }] as [{ text: string }],
    }));
  }

  // Call Gemini BEFORE creating/saving any conversation record
  // This prevents ghost conversations when the AI call fails
  const systemPrompt = buildSystemPrompt(profile, cabinetItems, language, journalLogs, sideEffects);

  // Build message parts — text + optional image
  const messageParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: userMessage },
  ];
  if (imageBase64 && imageMimeType) {
    messageParts.push({
      inlineData: { data: imageBase64, mimeType: imageMimeType },
    });
  }

  // AI call with automatic fallback — if this throws, no conversation record is created
  const chatResult = await sendWithFallback(systemPrompt, existingHistory, messageParts);
  const rawContent = chatResult.response.text();

  const usage = chatResult.response.usageMetadata;
  console.log(
    `[AI] model=${MODELS.CHAT} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=chat`
  );
  const aiUsage = buildAiUsage(MODELS.CHAT, usage?.promptTokenCount, usage?.candidatesTokenCount);

  const { clean: withoutActions, actions } = parseActions(rawContent);
  const { clean: assistantContent, suggestions } = parseSuggestions(withoutActions);

  const userMsg = { role: 'user' as const, content: userMessage, timestamp: new Date() };
  const assistantMsg = {
    role: 'assistant' as const,
    content: assistantContent,
    timestamp: new Date(),
    ...(actions.length > 0 ? { actions: actions.map((a) => ({ ...a, applied: false })) } : {}),
  };

  // Now persist — AI succeeded so it's safe to create/update the conversation
  let conversation: NonNullable<typeof existingConversation>;
  const isNewConversation = !conversationId;
  if (existingConversation) {
    existingConversation.messages.push(userMsg, assistantMsg);
    await existingConversation.save();
    conversation = existingConversation;
  } else {
    // Strip any [Page context ...] prefix injected by the frontend before using as title
    const titleSource = userMessage.replace(/^\[Page context[^\]]*\][\s\S]*?---\s*\n+(?:User:\s*)?/i, '').trim();
    conversation = await Conversation.create({
      userId: userObjectId,
      title: sessionTitle ?? generateTitle(titleSource),
      messages: [userMsg, assistantMsg],
    });
  }

  // Fire async title+summary generation after first exchange (non-blocking)
  // Skip if a sessionTitle was provided — it's already human-readable
  if (isNewConversation && !sessionTitle) {
    const titleSource = userMessage.replace(/^\[Page context[^\]]*\][\s\S]*?---\s*\n+(?:User:\s*)?/i, '').trim();
    void generateTitleAndSummary(String(conversation._id), titleSource, language);
  }

  // Run extraction in background (non-blocking) — data is NOT auto-applied,
  // it's returned as extractedData for reference. The user approves via action buttons.
  let extractedData: ExtractionResult | null = null;
  try {
    extractedData = await extractHealthData(userMessage);
    // Only auto-apply if there are NO actions (i.e. AI didn't surface them as buttons).
    // When actions are present, the user will click to approve.
    if (extractedData && actions.length === 0) {
      await applyExtractedData(userObjectId, extractedData);
    }
  } catch (err) {
    console.error('[Chat] Extraction error:', err);
  }

  return {
    conversationId: String(conversation._id),
    message: assistantMsg,
    extractedData: toFrontendExtraction(extractedData),
    detectedLanguage: language,
    suggestions,
    actions,
    aiUsage,
  };
}
