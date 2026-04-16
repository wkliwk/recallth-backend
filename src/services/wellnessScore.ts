import { GoogleGenerativeAI } from '@google/generative-ai';
import { IHealthProfile } from '../models/HealthProfile';
import { ICabinetItem } from '../models/CabinetItem';
import { MODELS } from '../config/models';
import { buildAiUsage, AiUsage } from '../utils/aiUsage';

// ─── Response types ────────────────────────────────────────────────────────

export interface CategoryBreakdown {
  score: number;
  max: number;
  detail: string;
}

export interface WellnessScoreResult {
  score: number;
  breakdown: {
    profileCompleteness: CategoryBreakdown;
    cabinetQuality: CategoryBreakdown;
    goalAlignment: CategoryBreakdown;
  };
  tips: string[];
  aiUsage?: AiUsage;
}

// ─── Profile completeness (deterministic, 40 pts max) ─────────────────────

const PROFILE_CATEGORIES = 6;
const PROFILE_MAX = 40;
const POINTS_PER_CATEGORY = PROFILE_MAX / PROFILE_CATEGORIES; // ~6.67

function isBodyFilled(body: IHealthProfile['body']): boolean {
  return !!(
    body?.height ||
    body?.weight ||
    body?.age ||
    body?.sex ||
    body?.bodyCompositionGoals
  );
}

function isDietFilled(diet: IHealthProfile['diet']): boolean {
  return !!(
    (diet?.preferences && diet.preferences.length > 0) ||
    (diet?.allergies && diet.allergies.length > 0) ||
    (diet?.intolerances && diet.intolerances.length > 0) ||
    diet?.dietType
  );
}

function isExerciseFilled(exercise: IHealthProfile['exercise']): boolean {
  return !!(
    (exercise?.type && exercise.type.length > 0) ||
    exercise?.frequency ||
    exercise?.intensity ||
    (exercise?.goals && exercise.goals.length > 0)
  );
}

function isSleepFilled(sleep: IHealthProfile['sleep']): boolean {
  return !!(
    sleep?.schedule ||
    sleep?.quality ||
    (sleep?.issues && sleep.issues.length > 0)
  );
}

function isLifestyleFilled(lifestyle: IHealthProfile['lifestyle']): boolean {
  return !!(
    lifestyle?.stressLevel ||
    lifestyle?.workType ||
    lifestyle?.alcohol ||
    lifestyle?.smoking
  );
}

function isGoalsFilled(goals: IHealthProfile['goals']): boolean {
  return !!(goals?.primary && goals.primary.length > 0);
}

export function scoreProfileCompleteness(profile: IHealthProfile | null): CategoryBreakdown {
  if (!profile) {
    return {
      score: 0,
      max: PROFILE_MAX,
      detail: '0 of 6 categories complete',
    };
  }

  const filled = [
    isBodyFilled(profile.body),
    isDietFilled(profile.diet),
    isExerciseFilled(profile.exercise),
    isSleepFilled(profile.sleep),
    isLifestyleFilled(profile.lifestyle),
    isGoalsFilled(profile.goals),
  ].filter(Boolean).length;

  const score = Math.round(filled * POINTS_PER_CATEGORY);

  return {
    score,
    max: PROFILE_MAX,
    detail: `${filled} of 6 categories complete`,
  };
}

// ─── Cabinet quality (deterministic, 30 pts max) ──────────────────────────

const CABINET_MAX = 30;
const MAJOR_INTERACTION_PENALTY = 10;

export function scoreCabinetQuality(
  activeItems: ICabinetItem[],
  hasMajorInteraction: boolean
): CategoryBreakdown {
  const count = activeItems.length;

  let base = 0;
  if (count >= 5) {
    base = 30;
  } else if (count >= 3) {
    base = 20;
  } else if (count >= 1) {
    base = 10;
  }

  const penalty = hasMajorInteraction ? MAJOR_INTERACTION_PENALTY : 0;
  const score = Math.max(0, base - penalty);

  let interactionNote = 'no major interactions';
  if (hasMajorInteraction) {
    interactionNote = 'major interaction detected';
  }

  const itemLabel = count === 1 ? 'supplement' : 'supplements';
  const detail = `${count} active ${itemLabel}, ${interactionNote}`;

  return {
    score,
    max: CABINET_MAX,
    detail,
  };
}

// ─── Goal alignment (AI call, 30 pts max) ─────────────────────────────────

const GOAL_ALIGNMENT_MAX = 30;

interface GeminiGoalAlignmentResponse {
  score: number;
  rationale: string;
}

function buildGoalAlignmentPrompt(goals: string[], cabinetNames: string[]): string {
  const goalList = goals.length > 0 ? goals.join(', ') : 'none specified';
  const cabinetList =
    cabinetNames.length > 0 ? cabinetNames.join(', ') : 'none';

  return `You are a health coach assessing how well a user's supplement cabinet supports their stated health goals.

User's health goals: ${goalList}
Current supplement/medication cabinet: ${cabinetList}

Score the alignment on a scale of 0 to 30, where:
- 0–10: Cabinet does not support the goals
- 11–20: Cabinet partially supports the goals
- 21–30: Cabinet strongly supports the goals

Return ONLY valid JSON in this exact format:
{
  "score": <integer 0-30>,
  "rationale": "<one sentence explaining the alignment>"
}

No other text. No markdown. Only the JSON object.`;
}

function parseGoalAlignmentResponse(text: string): GeminiGoalAlignmentResponse {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).score !== 'number' ||
    typeof (parsed as Record<string, unknown>).rationale !== 'string'
  ) {
    throw new Error('Gemini goal alignment response missing required fields');
  }

  const result = parsed as GeminiGoalAlignmentResponse;
  // Clamp score to valid range
  result.score = Math.min(GOAL_ALIGNMENT_MAX, Math.max(0, Math.round(result.score)));

  return result;
}

export async function scoreGoalAlignment(
  goals: string[],
  activeItems: ICabinetItem[]
): Promise<{ breakdown: CategoryBreakdown; aiUsage?: AiUsage }> {
  // If no goals or no cabinet items, score 0 with a clear detail message
  if (goals.length === 0) {
    return {
      breakdown: {
        score: 0,
        max: GOAL_ALIGNMENT_MAX,
        detail: 'No goals set — add goals to unlock this score.',
      },
    };
  }

  if (activeItems.length === 0) {
    return {
      breakdown: {
        score: 0,
        max: GOAL_ALIGNMENT_MAX,
        detail: 'No supplements in cabinet to assess against your goals.',
      },
    };
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  }

  const cabinetNames = activeItems.map((item) => item.name);
  const prompt = buildGoalAlignmentPrompt(goals, cabinetNames);

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: MODELS.WELLNESS });

  const response = await model.generateContent(prompt);
  const text = response.response.text();

  const usage = response.response.usageMetadata;
  console.log(
    `[AI] model=${MODELS.WELLNESS} input_tokens=${usage?.promptTokenCount} output_tokens=${usage?.candidatesTokenCount} task=wellness_goal_alignment`
  );
  const aiUsage = buildAiUsage(MODELS.WELLNESS, usage?.promptTokenCount, usage?.candidatesTokenCount);

  const result = parseGoalAlignmentResponse(text);

  return {
    breakdown: {
      score: result.score,
      max: GOAL_ALIGNMENT_MAX,
      detail: result.rationale,
    },
    aiUsage,
  };
}

// ─── Tips generator (deterministic) ───────────────────────────────────────

export function generateTips(
  profile: IHealthProfile | null,
  activeItemCount: number,
  breakdown: WellnessScoreResult['breakdown']
): string[] {
  const tips: string[] = [];

  // Profile completeness tips
  if (profile) {
    if (!isSleepFilled(profile.sleep)) {
      tips.push('Complete your Sleep profile to improve your score.');
    }
    if (!isGoalsFilled(profile.goals)) {
      tips.push('Add your health goals to unlock the Goal Alignment score.');
    }
    if (!isBodyFilled(profile.body)) {
      tips.push('Fill in your Body Stats to improve profile completeness.');
    }
    if (!isDietFilled(profile.diet)) {
      tips.push('Add your diet preferences to complete your health profile.');
    }
    if (!isExerciseFilled(profile.exercise)) {
      tips.push('Add your exercise habits to improve profile completeness.');
    }
    if (!isLifestyleFilled(profile.lifestyle)) {
      tips.push('Fill in your Lifestyle details to complete your profile.');
    }
  } else {
    tips.push('Create your health profile to start building your wellness score.');
  }

  // Cabinet tips
  if (activeItemCount < 3) {
    tips.push('Add more goal-aligned supplements based on your profile.');
  }

  // Goal alignment tips
  if (breakdown.goalAlignment.score < 15 && activeItemCount > 0) {
    tips.push('Consider supplements that better target your stated health goals.');
  }

  // Cap at 3 tips
  return tips.slice(0, 3);
}

// ─── Main aggregator ──────────────────────────────────────────────────────

export async function computeWellnessScore(
  profile: IHealthProfile | null,
  activeItems: ICabinetItem[],
  hasMajorInteraction: boolean
): Promise<WellnessScoreResult> {
  const goals = profile?.goals?.primary ?? [];

  const [profileBreakdown, cabinetBreakdown, goalAlignmentResult] = await Promise.all([
    Promise.resolve(scoreProfileCompleteness(profile)),
    Promise.resolve(scoreCabinetQuality(activeItems, hasMajorInteraction)),
    scoreGoalAlignment(goals, activeItems),
  ]);

  const goalBreakdown = goalAlignmentResult.breakdown;
  const aiUsage = goalAlignmentResult.aiUsage;

  const score = profileBreakdown.score + cabinetBreakdown.score + goalBreakdown.score;

  const breakdown: WellnessScoreResult['breakdown'] = {
    profileCompleteness: profileBreakdown,
    cabinetQuality: cabinetBreakdown,
    goalAlignment: goalBreakdown,
  };

  const tips = generateTips(profile, activeItems.length, breakdown);

  return {
    score: Math.min(100, Math.max(0, score)),
    breakdown,
    tips,
    ...(aiUsage ? { aiUsage } : {}),
  };
}
