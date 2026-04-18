/**
 * Seed script: import curated food items into the FoodItem collection.
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/scripts/seedFoodItems.ts --batch=B
 *   npx ts-node -r dotenv/config src/scripts/seedFoodItems.ts --batch=A
 *   npx ts-node -r dotenv/config src/scripts/seedFoodItems.ts --batch=all --confirm
 *
 * Flags:
 *   --batch=A     Parse chain restaurant PDFs via Gemini → output data/chain-review.json
 *   --batch=B     Import hand-authored cha chaan teng JSON (data/cha-chaan-teng.json)
 *   --batch=all   Run both A and B
 *   --confirm     Actually upsert into MongoDB (dry-run by default)
 *
 * Batch A (chain PDFs):
 *   Drop PDF files into data/chain-pdfs/ (one per chain).
 *   The script sends each to Gemini Flash for structured extraction and writes
 *   a review JSON to data/chain-review.json for manual inspection.
 *   Re-run with --confirm to import the reviewed JSON.
 *
 * Batch B (cha chaan teng JSON):
 *   data/cha-chaan-teng.json — hand-authored array of FoodItemSeed objects.
 *   See the interface below for the expected shape.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { FoodItem, computeNutritionFlags, FoodCategory, AccuracyTier } from '../models/FoodItem';

// ─── CLI argument parsing ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const getBatchArg = () => {
  const arg = args.find((a) => a.startsWith('--batch='));
  return arg ? arg.split('=')[1] : null;
};

const batchArg = getBatchArg();
const confirm = args.includes('--confirm');
const validBatches = ['A', 'B', 'all'];

if (!batchArg || !validBatches.includes(batchArg)) {
  console.error(`Usage: ... --batch=A|B|all [--confirm]`);
  process.exit(1);
}

const runA = batchArg === 'A' || batchArg === 'all';
const runB = batchArg === 'B' || batchArg === 'all';

// ─── Seed item shape ───────────────────────────────────────────────────────

interface FoodItemSeed {
  name: string;
  displayName?: string;
  aliases?: string[];
  category: FoodCategory;
  per100g: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    sugar?: number;
    fiber?: number;
    sodium?: number;
  };
  defaultServingGrams: number;
  defaultServingUnit: string;
  venue?: string;
  brand?: string;
  accuracyTier?: AccuracyTier;
}

// ─── Upsert helper ─────────────────────────────────────────────────────────

async function upsertItem(seed: FoodItemSeed): Promise<'created' | 'updated' | 'skipped'> {
  const canonicalName = seed.name.trim().toLowerCase();
  const nutritionFlags = computeNutritionFlags(seed.per100g, seed.defaultServingGrams);

  const doc = {
    name: canonicalName,
    displayName: seed.displayName ?? seed.name.trim(),
    aliases: seed.aliases ?? [],
    lang: 'zh-HK' as const,
    category: seed.category,
    brand: seed.brand,
    per100g: seed.per100g,
    defaultServingGrams: seed.defaultServingGrams,
    defaultServingUnit: seed.defaultServingUnit,
    source: 'community' as const,
    accuracyTier: seed.accuracyTier ?? ('B' as AccuracyTier),
    dataFreshnessDate: new Date(),
    contributionCount: 0,
    nutritionFlags,
    searchCount: 0,
    logCount: 0,
    status: 'active' as const,
  };

  const result = await FoodItem.updateOne(
    { name: canonicalName },
    { $set: doc },
    { upsert: true },
  );

  if (result.upsertedCount > 0) return 'created';
  if (result.modifiedCount > 0) return 'updated';
  return 'skipped';
}

// ─── Batch B: hand-authored JSON ───────────────────────────────────────────

async function runBatchB(): Promise<void> {
  const jsonPath = path.resolve(__dirname, '../../data/cha-chaan-teng.json');
  if (!fs.existsSync(jsonPath)) {
    console.log(`[Batch B] No file found at ${jsonPath} — skipping.`);
    console.log('Create data/cha-chaan-teng.json with an array of FoodItemSeed objects.');
    return;
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const items: FoodItemSeed[] = JSON.parse(raw);
  console.log(`[Batch B] Loaded ${items.length} items from ${jsonPath}`);

  if (!confirm) {
    console.log('[Batch B] DRY RUN — would import:');
    for (const item of items) {
      console.log(`  ${item.name} (${item.category}, ${item.per100g.calories} kcal/100g)`);
    }
    console.log('\nRe-run with --confirm to import into MongoDB.');
    return;
  }

  let created = 0, updated = 0, skipped = 0;
  for (const item of items) {
    const result = await upsertItem(item);
    if (result === 'created') created++;
    else if (result === 'updated') updated++;
    else skipped++;
    console.log(`  [${result}] ${item.name}`);
  }

  console.log(`\n[Batch B] Done: created=${created} updated=${updated} skipped=${skipped}`);
}

// ─── Batch A: chain PDFs via Gemini ────────────────────────────────────────

async function runBatchA(): Promise<void> {
  const pdfsDir = path.resolve(__dirname, '../../data/chain-pdfs');
  const reviewPath = path.resolve(__dirname, '../../data/chain-review.json');

  if (confirm && fs.existsSync(reviewPath)) {
    // --confirm: import the reviewed JSON
    const raw = fs.readFileSync(reviewPath, 'utf-8');
    const items: FoodItemSeed[] = JSON.parse(raw);
    console.log(`[Batch A] Importing ${items.length} reviewed items from chain-review.json`);

    let created = 0, updated = 0, skipped = 0;
    for (const item of items) {
      const result = await upsertItem(item);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else skipped++;
      console.log(`  [${result}] ${item.name}`);
    }

    console.log(`\n[Batch A] Done: created=${created} updated=${updated} skipped=${skipped}`);
    return;
  }

  // Extraction mode: process PDFs → write review JSON
  if (!fs.existsSync(pdfsDir)) {
    console.log(`[Batch A] No data/chain-pdfs/ directory found.`);
    console.log('Create the directory and drop chain restaurant PDF menus into it, then re-run.');
    return;
  }

  const pdfFiles = fs.readdirSync(pdfsDir).filter((f) => f.endsWith('.pdf'));
  if (pdfFiles.length === 0) {
    console.log(`[Batch A] No PDF files found in ${pdfsDir}`);
    return;
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[Batch A] GOOGLE_GEMINI_API_KEY is not set');
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const allExtracted: FoodItemSeed[] = [];

  for (const file of pdfFiles) {
    const filePath = path.join(pdfsDir, file);
    const brand = path.basename(file, '.pdf');
    console.log(`[Batch A] Processing ${file} (brand: ${brand})...`);

    const pdfData = fs.readFileSync(filePath);
    const base64 = pdfData.toString('base64');

    const prompt = `You are a nutrition data extractor. Extract ALL food items and their nutrition data from this chain restaurant menu/nutrition PDF.
For each item return a JSON object with these exact fields:
- name: Chinese name (Traditional Chinese, as it appears on the menu)
- displayName: same as name
- aliases: array of alternative names (English name, Cantonese name variants) if known, else []
- category: one of "rice_noodles", "protein", "dim_sum", "soup", "bread_pastry", "drinks", "desserts", "snacks", "fast_food", "whole_food", "packaged"
- per100g: object with calories (kcal), protein (g), carbs (g), fat (g), sugar (g, optional), fiber (g, optional), sodium (mg, optional) — all per 100g
- defaultServingGrams: typical serving weight in grams
- defaultServingUnit: Chinese measure word (份, 個, 杯, 碗, 件, etc.)
- accuracyTier: "A" (direct from official PDF)

If the PDF lists nutrients per serving, convert to per 100g: (nutrient / serving_grams) * 100.

Return ONLY a valid JSON array, no markdown, no explanation.`;

    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'application/pdf', data: base64 } },
      ]);
      const raw = result.response.text().trim();
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`  [warn] Could not find JSON array in response for ${file}`);
        continue;
      }
      const items: FoodItemSeed[] = JSON.parse(jsonMatch[0]);
      const tagged = items.map((item) => ({ ...item, brand }));
      allExtracted.push(...tagged);
      console.log(`  Extracted ${items.length} items from ${file}`);
    } catch (err) {
      console.error(`  [error] Failed to process ${file}:`, err);
    }
  }

  fs.writeFileSync(reviewPath, JSON.stringify(allExtracted, null, 2), 'utf-8');
  console.log(`\n[Batch A] Wrote ${allExtracted.length} items to data/chain-review.json`);
  console.log('Review the file, then re-run with --confirm to import into MongoDB.');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  if (confirm) {
    await mongoose.connect(uri);
    console.log('MongoDB connected\n');
  }

  if (runA) await runBatchA();
  if (runB) await runBatchB();

  if (confirm) {
    await mongoose.disconnect();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
