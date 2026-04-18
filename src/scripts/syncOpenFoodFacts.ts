/**
 * OFF sync script: import HK packaged food from world.openfoodfacts.org
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/scripts/syncOpenFoodFacts.ts
 *   npx ts-node -r dotenv/config src/scripts/syncOpenFoodFacts.ts --dry-run
 *
 * Schedule via Railway Cron Job (weekly, e.g. every Monday 03:00 HKT):
 *   Command: npx ts-node -r dotenv/config src/scripts/syncOpenFoodFacts.ts
 *   Cron:    0 19 * * 0  (Sunday 19:00 UTC = Monday 03:00 HKT)
 *
 * What it does:
 *   - Fetches HK-tagged packaged products from OFF v2 API (paginated)
 *   - Filters to items with calories + all macros present
 *   - Maps OFF fields → FoodItem schema
 *   - Upserts as source:'openfoodfacts', accuracyTier:'B', category:'packaged'
 *   - Only touches items sourced from 'openfoodfacts' (won't overwrite official/community data)
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { FoodItem, computeNutritionFlags } from '../models/FoodItem';

const PAGE_SIZE = 200;
const MAX_PAGES = 25; // cap at 5,000 products per run
const OFF_API_BASE = 'https://world.openfoodfacts.org/cgi/search.pl';

const dryRun = process.argv.includes('--dry-run');

// ─── OFF API types (partial) ───────────────────────────────────────────────

interface OFFProduct {
  code: string;
  product_name?: string;
  product_name_zh?: string;
  product_name_en?: string;
  brands?: string;
  serving_size?: string;
  serving_quantity?: number;
  nutriments?: {
    'energy-kcal_100g'?: number;
    'energy-kcal'?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    sugars_100g?: number;
    fiber_100g?: number;
    sodium_100g?: number;
  };
}

interface OFFResponse {
  count: number;
  page: number;
  page_size: number;
  products: OFFProduct[];
}

// ─── OFF → FoodItem mapper ─────────────────────────────────────────────────

function mapOFFProduct(p: OFFProduct): {
  name: string;
  displayName: string;
  brand: string;
  dataSourceUrl: string;
  per100g: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    sugar?: number;
    fiber?: number;
    sodium?: number;
  };
} | null {
  const n = p.nutriments;
  if (!n) return null;

  const calories = n['energy-kcal_100g'] ?? n['energy-kcal'] ?? null;
  const protein = n.proteins_100g ?? null;
  const carbs = n.carbohydrates_100g ?? null;
  const fat = n.fat_100g ?? null;

  if (calories == null || protein == null || carbs == null || fat == null) return null;
  if (calories < 0 || protein < 0 || carbs < 0 || fat < 0) return null;

  // Sanity: macro kcal should be in rough range of stated calories
  const macroKcal = protein * 4 + carbs * 4 + fat * 9;
  if (macroKcal > calories * 2.5 || (macroKcal < calories * 0.2 && macroKcal > 10)) return null;

  const rawName =
    p.product_name_zh?.trim() ||
    p.product_name?.trim() ||
    p.product_name_en?.trim() ||
    p.code;

  if (!rawName) return null;

  return {
    name: rawName.toLowerCase(),
    displayName: rawName,
    brand: p.brands?.split(',')[0]?.trim() ?? '',
    dataSourceUrl: `https://world.openfoodfacts.org/product/${p.code}`,
    per100g: {
      calories: Math.round(calories * 10) / 10,
      protein: Math.round(protein * 10) / 10,
      carbs: Math.round(carbs * 10) / 10,
      fat: Math.round(fat * 10) / 10,
      sugar: n.sugars_100g != null ? Math.round(n.sugars_100g * 10) / 10 : undefined,
      fiber: n.fiber_100g != null ? Math.round(n.fiber_100g * 10) / 10 : undefined,
      sodium: n.sodium_100g != null ? Math.round(n.sodium_100g * 1000 * 10) / 10 : undefined, // OFF stores in g, we want mg
    },
  };
}

// ─── Fetch one page from OFF ───────────────────────────────────────────────

async function fetchPage(page: number): Promise<OFFResponse> {
  const params = new URLSearchParams({
    action: 'process',
    tagtype_0: 'countries',
    tag_0: 'hong-kong',
    page_size: String(PAGE_SIZE),
    page: String(page),
    json: '1',
    fields: [
      'code',
      'product_name',
      'product_name_zh',
      'product_name_en',
      'brands',
      'serving_size',
      'serving_quantity',
      'nutriments',
    ].join(','),
  });

  const url = `${OFF_API_BASE}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'RecallthApp/1.0 (recallth.com)',
    },
  });

  if (!res.ok) throw new Error(`OFF API responded ${res.status} for page ${page}`);
  return res.json() as Promise<OFFResponse>;
}

// ─── Upsert helper ─────────────────────────────────────────────────────────

async function upsertProduct(mapped: ReturnType<typeof mapOFFProduct> & {}): Promise<'created' | 'updated' | 'skipped'> {
  if (!mapped) return 'skipped';

  const defaultServingGrams = 100;
  const nutritionFlags = computeNutritionFlags(mapped.per100g, defaultServingGrams);

  // Only upsert if not already an official or community-verified source
  const existing = await FoodItem.findOne({ name: mapped.name }).lean();
  if (existing && existing.source !== 'openfoodfacts') {
    return 'skipped'; // don't overwrite higher-quality data
  }

  const doc = {
    name: mapped.name,
    displayName: mapped.displayName,
    aliases: [],
    lang: 'zh-HK' as const,
    category: 'packaged' as const,
    brand: mapped.brand || undefined,
    dataSourceUrl: mapped.dataSourceUrl,
    per100g: mapped.per100g,
    defaultServingGrams,
    defaultServingUnit: '份',
    source: 'openfoodfacts' as const,
    accuracyTier: 'B' as const,
    dataFreshnessDate: new Date(),
    contributionCount: 0,
    nutritionFlags,
    searchCount: 0,
    logCount: 0,
    status: 'active' as const,
  };

  const result = await FoodItem.updateOne(
    { name: mapped.name },
    { $set: doc },
    { upsert: true },
  );

  if (result.upsertedCount > 0) return 'created';
  if (result.modifiedCount > 0) return 'updated';
  return 'skipped';
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  console.log(`[OFF sync] Starting${dryRun ? ' (DRY RUN)' : ''}...`);

  if (!dryRun) {
    await mongoose.connect(uri);
    console.log('[OFF sync] MongoDB connected');
  }

  let totalFetched = 0;
  let totalValid = 0;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let data: OFFResponse;
    try {
      data = await fetchPage(page);
    } catch (err) {
      console.error(`[OFF sync] Failed to fetch page ${page}:`, err);
      break;
    }

    if (!data.products || data.products.length === 0) {
      console.log(`[OFF sync] No more products at page ${page} — done.`);
      break;
    }

    totalFetched += data.products.length;

    for (const product of data.products) {
      const mapped = mapOFFProduct(product);
      if (!mapped) continue;
      totalValid++;

      if (dryRun) {
        console.log(`  [dry] ${mapped.displayName} — ${mapped.per100g.calories} kcal, ${mapped.per100g.protein}g protein`);
        continue;
      }

      const result = await upsertProduct(mapped);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else skipped++;
    }

    const totalProducts = data.count;
    const pagesNeeded = Math.min(Math.ceil(totalProducts / PAGE_SIZE), MAX_PAGES);
    console.log(`[OFF sync] Page ${page}/${pagesNeeded}: fetched=${data.products.length} valid_so_far=${totalValid}`);

    if (page * PAGE_SIZE >= totalProducts) break;

    // Brief pause to be polite to OFF servers
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n[OFF sync] Summary:`);
  console.log(`  Total fetched: ${totalFetched}`);
  console.log(`  Valid macros:  ${totalValid}`);
  if (!dryRun) {
    console.log(`  Created:       ${created}`);
    console.log(`  Updated:       ${updated}`);
    console.log(`  Skipped:       ${skipped}`);
    await mongoose.disconnect();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[OFF sync] Fatal error:', err);
  process.exit(1);
});
