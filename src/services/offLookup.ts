import { NutritionOffCache } from '../models/NutritionOffCache';

// Estimated grams per common serving unit for scaling OFF per-100g data
const UNIT_WEIGHT_G: Record<string, number> = {
  份: 350,
  碟: 400,
  碗: 350,
  杯: 250,
  包: 200,
  盒: 300,
  罐: 330,
  個: 120,
  件: 100,
  塊: 100,
  片: 30,
  粒: 15,
  條: 80,
  g: 1,
  kg: 1000,
  ml: 1,
};

function estimateWeightG(quantity: number, unit: string): number {
  const unitLower = unit.trim().toLowerCase();
  const multiplier = UNIT_WEIGHT_G[unit] ?? UNIT_WEIGHT_G[unitLower] ?? 150; // default 150g
  return quantity * multiplier;
}

interface NutrientsPer100g {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  sugar?: number;
  fiber?: number;
  sodium?: number;
}

interface OffLookupResult {
  productName: string;
  nutrients: NutrientsPer100g;
  scaledNutrients: NutrientsPer100g;
}

function scaleNutrients(per100g: NutrientsPer100g, weightG: number): NutrientsPer100g {
  const factor = weightG / 100;
  const round1 = (v?: number) => v !== undefined ? Math.round(v * factor * 10) / 10 : undefined;
  return {
    calories: round1(per100g.calories),
    protein: round1(per100g.protein),
    carbs: round1(per100g.carbs),
    fat: round1(per100g.fat),
    sugar: round1(per100g.sugar),
    fiber: round1(per100g.fiber),
    sodium: round1(per100g.sodium),
  };
}

function extractNutrients(nutriments: Record<string, unknown>): NutrientsPer100g {
  const num = (key: string): number | undefined => {
    const v = nutriments[key];
    return typeof v === 'number' ? v : undefined;
  };
  return {
    calories: num('energy-kcal_100g') ?? num('energy_100g'),
    protein: num('proteins_100g'),
    carbs: num('carbohydrates_100g'),
    fat: num('fat_100g'),
    sugar: num('sugars_100g'),
    fiber: num('fiber_100g'),
    sodium: num('sodium_100g') !== undefined
      ? Math.round((num('sodium_100g') as number) * 1000) // g → mg
      : undefined,
  };
}

const OFF_HOSTS = [
  'https://hk.openfoodfacts.org',
  'https://world.openfoodfacts.org',
];

async function fetchFromOff(query: string): Promise<{ productName: string; per100g: NutrientsPer100g } | null> {
  for (const host of OFF_HOSTS) {
    try {
      const url = `${host}/api/v2/search?search_terms=${encodeURIComponent(query)}&page_size=1&fields=product_name,nutriments&json=true`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Recallth/1.0 (nutrition lookup; contact@recallth.com)' },
      });

      if (!res.ok) continue;

      const data = await res.json() as { products?: Array<{ product_name?: string; nutriments?: Record<string, unknown> }> };
      const product = data.products?.[0];
      if (!product?.nutriments || !product.product_name) continue;

      const per100g = extractNutrients(product.nutriments);
      // Require at least calories to consider a valid match
      if (per100g.calories === undefined) continue;

      return { productName: product.product_name, per100g };
    } catch {
      // timeout, network error, JSON parse error — try next host
      continue;
    }
  }
  return null;
}

/**
 * Look up nutrition data from OFF for a food item.
 * Returns scaled nutrients for the given quantity+unit, or null if not found / OFF unavailable.
 * Caches successful lookups in MongoDB.
 */
export async function offLookup(
  name: string,
  quantity: number,
  unit: string,
): Promise<OffLookupResult | null> {
  const cacheKey = name.trim().toLowerCase();
  const weightG = estimateWeightG(quantity, unit);

  // 1. Try MongoDB cache first
  try {
    const cached = await NutritionOffCache.findOne({ query: cacheKey }).lean();
    if (cached) {
      return {
        productName: cached.offProductName,
        nutrients: cached.per100g,
        scaledNutrients: scaleNutrients(cached.per100g, weightG),
      };
    }
  } catch {
    // DB unavailable — fall through to live fetch
  }

  // 2. Fetch from OFF
  const offResult = await fetchFromOff(name);
  if (!offResult) return null;

  // 3. Save to cache
  try {
    await NutritionOffCache.findOneAndUpdate(
      { query: cacheKey },
      { query: cacheKey, offProductName: offResult.productName, per100g: offResult.per100g, fetchedAt: new Date() },
      { upsert: true },
    );
  } catch {
    // Cache write failure is non-fatal
  }

  return {
    productName: offResult.productName,
    nutrients: offResult.per100g,
    scaledNutrients: scaleNutrients(offResult.per100g, weightG),
  };
}
