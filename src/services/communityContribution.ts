import { CommunityFoodItem, NutrientsPer100g } from '../models/CommunityFoodItem';
import { UserSettings } from '../models/UserSettings';

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
): NutrientsPer100g {
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
    const existing = await CommunityFoodItem.findOne({ name: canonicalName }).lean();

    if (!existing) {
      // First contribution — create as unverified
      await CommunityFoodItem.create({
        name: canonicalName,
        aliases: [],
        per100g,
        contributionCount: 1,
        calorieRange: { min: per100g.calories, max: per100g.calories },
        status: 'unverified',
        lastUpdated: new Date(),
        _calM2: 0,
      });
      return;
    }

    const n = existing.contributionCount;
    const currentCalMean = existing.per100g.calories ?? per100g.calories;

    // Outlier check — only applies once we have enough data for a meaningful stddev
    if (n >= 2) {
      const variance = existing._calM2 / n;
      const stddev = Math.sqrt(variance);
      if (Math.abs(per100g.calories - currentCalMean) > OUTLIER_SIGMA * stddev) {
        // Flagged outlier — skip, do not include in average
        console.log(`[communityDB] outlier skipped: ${canonicalName} cal=${per100g.calories} mean=${currentCalMean} stddev=${stddev}`);
        return;
      }
    }

    const newN = n + 1;

    // Update running Welford mean & M2 for calories
    const { mean: newCalMean, m2: newCalM2 } = welfordUpdate(newN, currentCalMean, existing._calM2, per100g.calories);

    // Update running averages for all nutrients
    function updateNutrientMean(current: number | undefined, newVal: number | undefined): number | undefined {
      if (newVal == null) return current;
      if (current == null) return newVal;
      return Math.round(((current * n + newVal) / newN) * 10) / 10;
    }

    const newPer100g: NutrientsPer100g = {
      calories: Math.round(newCalMean * 10) / 10,
      protein:  updateNutrientMean(existing.per100g.protein, per100g.protein),
      carbs:    updateNutrientMean(existing.per100g.carbs, per100g.carbs),
      fat:      updateNutrientMean(existing.per100g.fat, per100g.fat),
      sugar:    updateNutrientMean(existing.per100g.sugar, per100g.sugar),
      fiber:    updateNutrientMean(existing.per100g.fiber, per100g.fiber),
      sodium:   updateNutrientMean(existing.per100g.sodium, per100g.sodium),
    };

    const newCalorieRange = {
      min: Math.min(existing.calorieRange.min, per100g.calories),
      max: Math.max(existing.calorieRange.max, per100g.calories),
    };

    // Determine new status
    let newStatus = existing.status;
    if (newStatus !== 'verified') {
      const stddev = Math.sqrt(newCalM2 / newN);
      const pct = newCalMean > 0 ? stddev / newCalMean : 1;
      if (newN >= COMMUNITY_THRESHOLD && pct < COMMUNITY_VARIANCE_PCT) {
        newStatus = 'community';
      }
    }

    await CommunityFoodItem.findOneAndUpdate(
      { name: canonicalName },
      {
        per100g: newPer100g,
        contributionCount: newN,
        calorieRange: newCalorieRange,
        status: newStatus,
        lastUpdated: new Date(),
        _calM2: newCalM2,
      },
    );
  } catch (err) {
    // Never let community DB errors bubble up to the user's request
    console.error('[communityDB] contribution error:', err);
  }
}
