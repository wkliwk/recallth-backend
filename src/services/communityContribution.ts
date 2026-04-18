import { FoodItem, computeNutritionFlags } from '../models/FoodItem';
import { UserSettings } from '../models/UserSettings';

interface RawNutrients {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  sugar?: number;
  fiber?: number;
  sodium?: number;
}

// Reuse the same unit→grams table as offLookup
const UNIT_WEIGHT_G: Record<string, number> = {
  份: 350, 碟: 400, 碗: 350, 杯: 250, 包: 200, 盒: 300,
  罐: 330, 個: 120, 件: 100, 塊: 100, 片: 30, 粒: 15,
  條: 80, g: 1, kg: 1000, ml: 1,
};

function estimateWeightG(quantity: number, unit: string): number {
  const multiplier = UNIT_WEIGHT_G[unit] ?? UNIT_WEIGHT_G[unit.trim().toLowerCase()] ?? 150;
  return quantity * multiplier;
}

function toNutrientsPer100g(
  nutrients: Record<string, number>,
  weightG: number,
): RawNutrients {
  if (weightG <= 0) return {};
  const factor = 100 / weightG;
  const scale = (key: string): number | undefined => {
    const v = nutrients[key];
    return typeof v === 'number' ? Math.round(v * factor * 10) / 10 : undefined;
  };
  return {
    calories: scale('calories'),
    protein:  scale('protein'),
    carbs:    scale('carbs'),
    fat:      scale('fat'),
    sugar:    scale('sugar'),
    fiber:    scale('fiber'),
    sodium:   scale('sodium'),
  };
}

// Welford online update for running mean and M2 (for variance)
function welfordUpdate(
  n: number,
  mean: number,
  m2: number,
  newValue: number,
): { mean: number; m2: number } {
  const delta = newValue - mean;
  const newMean = mean + delta / n;
  const delta2 = newValue - newMean;
  return { mean: newMean, m2: m2 + delta * delta2 };
}

// Minimum contribution count + low variance required to reach 'community' status
const COMMUNITY_THRESHOLD = 3;
const COMMUNITY_VARIANCE_PCT = 0.20; // stddev must be < 20% of mean
const OUTLIER_SIGMA = 2;             // flag if > 2 stddev from mean

interface FoodContribution {
  name: string;        // raw food name from log (will be normalised)
  quantity: number;
  unit: string;
  nutrients: Record<string, number>; // per-serving nutrients
}

/**
 * Contribute a logged food item to the community food DB.
 * Call fire-and-forget after a meal entry is successfully saved.
 * Non-fatal: any error is swallowed so it never blocks the user's request.
 */
export async function contributeToCommDB(
  userId: string,
  food: FoodContribution,
): Promise<void> {
  try {
    // Check user opt-out
    const settings = await UserSettings.findOne({ userId }).lean();
    if (settings && settings.communityContributeEnabled === false) return;

    if (!food.name || food.quantity <= 0) return;

    const weightG = estimateWeightG(food.quantity, food.unit);
    if (weightG <= 0) return;

    const per100g = toNutrientsPer100g(food.nutrients, weightG);
    if (per100g.calories == null) return; // require calories to contribute

    const canonicalName = food.name.trim().toLowerCase();

    // Fetch existing entry (or create skeleton for first contribution)
    const existing = await FoodItem.findOne({ name: canonicalName }).lean();

    const defaultServingGrams = 100;
    const safeNutrients = {
      calories: per100g.calories ?? 0,
      protein:  per100g.protein ?? 0,
      carbs:    per100g.carbs ?? 0,
      fat:      per100g.fat ?? 0,
      sugar:    per100g.sugar,
      fiber:    per100g.fiber,
      sodium:   per100g.sodium,
    };

    if (!existing) {
      const nutritionFlags = computeNutritionFlags(safeNutrients, defaultServingGrams);
      await FoodItem.create({
        name: canonicalName,
        displayName: canonicalName,
        aliases: [],
        lang: 'zh-HK',
        category: 'whole_food',
        per100g: safeNutrients,
        defaultServingGrams,
        defaultServingUnit: '份',
        source: 'community',
        accuracyTier: 'C',
        dataFreshnessDate: new Date(),
        contributionCount: 1,
        nutritionFlags,
        searchCount: 0,
        logCount: 0,
        status: 'active',
      });
      return;
    }

    // Only update community-sourced items (don't overwrite official data)
    if (existing.source !== 'community') return;

    const n = existing.contributionCount;
    const currentCalMean = existing.per100g.calories;

    // Outlier check (simple 50% threshold)
    if (n >= 2) {
      if (Math.abs(safeNutrients.calories - currentCalMean) > currentCalMean * 0.5) {
        console.log(`[communityDB] outlier skipped: ${canonicalName}`);
        return;
      }
    }

    const newN = n + 1;

    function updateMean(current: number | undefined, newVal: number | undefined): number | undefined {
      if (newVal == null) return current;
      if (current == null) return newVal;
      return Math.round(((current * n + newVal) / newN) * 10) / 10;
    }

    const newPer100g = {
      calories: Math.round(((currentCalMean * n + safeNutrients.calories) / newN) * 10) / 10,
      protein:  updateMean(existing.per100g.protein, safeNutrients.protein) ?? 0,
      carbs:    updateMean(existing.per100g.carbs, safeNutrients.carbs) ?? 0,
      fat:      updateMean(existing.per100g.fat, safeNutrients.fat) ?? 0,
      sugar:    updateMean(existing.per100g.sugar, safeNutrients.sugar),
      fiber:    updateMean(existing.per100g.fiber, safeNutrients.fiber),
      sodium:   updateMean(existing.per100g.sodium, safeNutrients.sodium),
    };

    const newTier = (newN >= COMMUNITY_THRESHOLD && existing.accuracyTier === 'C') ? 'B' : existing.accuracyTier;
    const newFlags = computeNutritionFlags(newPer100g, defaultServingGrams);

    await FoodItem.findOneAndUpdate(
      { name: canonicalName },
      {
        per100g: newPer100g,
        contributionCount: newN,
        accuracyTier: newTier,
        nutritionFlags: newFlags,
        dataFreshnessDate: new Date(),
      },
    );
  } catch (err) {
    // Never let community DB errors bubble up to the user's request
    console.error('[communityDB] contribution error:', err);
  }
}
