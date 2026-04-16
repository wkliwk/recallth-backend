import type { NutritionCategory } from '../models/Nutrition';
import type { ActivityLevel } from '../models/HealthProfile';

export interface NutrientTarget {
  nutrient: string;
  unit: string;
  dailyTarget: number;
  type: 'min' | 'max';
}

// ─── Activity multipliers ─────────────────────────────────────────────────────
const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary:   1.2,
  light:       1.375,
  moderate:    1.55,
  active:      1.725,
  very_active: 1.9,
};

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary:   'Sedentary',
  light:       'Lightly active',
  moderate:    'Moderately active',
  active:      'Active',
  very_active: 'Very active',
};

// ─── Personalised target calculation ─────────────────────────────────────────

export interface PersonalisedFormula {
  weightKg: number;
  heightCm: number;
  age: number;
  sex: 'male' | 'female';
  activityLevel: ActivityLevel;
  activityMultiplier: number;
  bmr: number;
  tdee: number;
  calorieTarget: number;
  proteinTarget: number;
  calorieAdjustmentLabel: string;
}

export interface PersonalisedResult {
  targets: NutrientTarget[];
  formula: PersonalisedFormula;
}

export function computePersonalisedTargets(
  category: NutritionCategory,
  weightKg: number,
  heightCm: number,
  age: number,
  sex: 'male' | 'female',
  activityLevel: ActivityLevel
): PersonalisedResult {
  const r = (n: number) => Math.round(n);

  // Mifflin-St Jeor BMR
  const bmr = sex === 'male'
    ? r(10 * weightKg + 6.25 * heightCm - 5 * age + 5)
    : r(10 * weightKg + 6.25 * heightCm - 5 * age - 161);

  const multiplier = ACTIVITY_MULTIPLIERS[activityLevel];
  const tdee = r(bmr * multiplier);

  // Calorie target per category
  const calorieAdjustments: Record<NutritionCategory, { delta: number; label: string }> = {
    gym:           { delta: +300, label: '+300 kcal (muscle gain surplus)' },
    'weight-loss': { delta: -500, label: '−500 kcal (weight loss deficit)' },
    diabetes:      { delta: 0,    label: 'maintenance' },
    kidney:        { delta: 0,    label: 'maintenance' },
    pregnancy:     { delta: +300, label: '+300 kcal (pregnancy)' },
    custom:        { delta: 0,    label: 'maintenance' },
  };
  const adj = calorieAdjustments[category];
  const calorieTarget = Math.max(1200, r(tdee + adj.delta));

  // Protein target per category (g/kg body weight)
  const proteinFactors: Record<NutritionCategory, number> = {
    gym:           2.0,
    'weight-loss': 1.6,
    pregnancy:     1.5,
    kidney:        0.8,
    diabetes:      1.2,
    custom:        1.2,
  };
  const proteinTarget = r(weightKg * proteinFactors[category]);

  // Build target array — personalise calories + protein, keep rest from defaults
  const defaults = CATEGORY_TARGETS[category];
  const targets: NutrientTarget[] = defaults.map((t) => {
    if (t.nutrient === 'calories') return { ...t, dailyTarget: calorieTarget };
    if (t.nutrient === 'protein')  return { ...t, dailyTarget: proteinTarget };
    return t;
  });

  return {
    targets,
    formula: {
      weightKg, heightCm, age, sex, activityLevel,
      activityMultiplier: multiplier,
      bmr, tdee, calorieTarget, proteinTarget,
      calorieAdjustmentLabel: adj.label,
    },
  };
}

// ─── Hardcoded defaults ───────────────────────────────────────────────────────
export const CATEGORY_TARGETS: Record<NutritionCategory, NutrientTarget[]> = {
  gym: [
    { nutrient: 'calories', unit: 'kcal', dailyTarget: 2500, type: 'min' },
    { nutrient: 'protein', unit: 'g', dailyTarget: 150, type: 'min' },
    { nutrient: 'carbs', unit: 'g', dailyTarget: 300, type: 'min' },
    { nutrient: 'fat', unit: 'g', dailyTarget: 80, type: 'min' },
  ],
  'weight-loss': [
    { nutrient: 'calories', unit: 'kcal', dailyTarget: 1800, type: 'max' },
    { nutrient: 'fat', unit: 'g', dailyTarget: 60, type: 'max' },
    { nutrient: 'sugar', unit: 'g', dailyTarget: 50, type: 'max' },
    { nutrient: 'fiber', unit: 'g', dailyTarget: 25, type: 'min' },
  ],
  diabetes: [
    { nutrient: 'carbs', unit: 'g', dailyTarget: 130, type: 'max' },
    { nutrient: 'sugar', unit: 'g', dailyTarget: 25, type: 'max' },
    { nutrient: 'fiber', unit: 'g', dailyTarget: 25, type: 'min' },
    { nutrient: 'calories', unit: 'kcal', dailyTarget: 2000, type: 'max' },
  ],
  kidney: [
    { nutrient: 'sodium', unit: 'mg', dailyTarget: 1500, type: 'max' },
    { nutrient: 'potassium', unit: 'mg', dailyTarget: 2000, type: 'max' },
    { nutrient: 'phosphorus', unit: 'mg', dailyTarget: 800, type: 'max' },
    { nutrient: 'protein', unit: 'g', dailyTarget: 60, type: 'max' },
  ],
  pregnancy: [
    { nutrient: 'calories', unit: 'kcal', dailyTarget: 2200, type: 'min' },
    { nutrient: 'protein', unit: 'g', dailyTarget: 71, type: 'min' },
    { nutrient: 'folate', unit: 'µg', dailyTarget: 600, type: 'min' },
    { nutrient: 'iron', unit: 'mg', dailyTarget: 27, type: 'min' },
    { nutrient: 'calcium', unit: 'mg', dailyTarget: 1000, type: 'min' },
  ],
  custom: [
    { nutrient: 'calories', unit: 'kcal', dailyTarget: 2000, type: 'min' },
    { nutrient: 'protein', unit: 'g', dailyTarget: 50, type: 'min' },
    { nutrient: 'carbs', unit: 'g', dailyTarget: 250, type: 'min' },
    { nutrient: 'fat', unit: 'g', dailyTarget: 65, type: 'min' },
  ],
};
