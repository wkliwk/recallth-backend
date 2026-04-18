/**
 * Migration script: CommunityFoodItem → FoodItem
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/scripts/migrateCommunityFoodItems.ts
 *
 * Safe to run multiple times (upserts by name). Does NOT drop CommunityFoodItem.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { CommunityFoodItem } from '../models/CommunityFoodItem';
import { FoodItem, computeNutritionFlags } from '../models/FoodItem';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('MongoDB connected');

  const items = await CommunityFoodItem.find({}).lean();
  console.log(`Found ${items.length} CommunityFoodItem documents`);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      const per100g = {
        calories: item.per100g.calories ?? 0,
        protein:  item.per100g.protein ?? 0,
        carbs:    item.per100g.carbs ?? 0,
        fat:      item.per100g.fat ?? 0,
        sugar:    item.per100g.sugar,
        fiber:    item.per100g.fiber,
        sodium:   item.per100g.sodium,
      };

      // Skip items with zero calories (incomplete data)
      if (per100g.calories === 0 && per100g.protein === 0) {
        skipped++;
        continue;
      }

      const defaultServingGrams = 100;
      const accuracyTier = item.status === 'verified' ? 'A' : item.status === 'community' ? 'B' : 'C';
      const nutritionFlags = computeNutritionFlags(per100g, defaultServingGrams);

      const doc = {
        name:        item.name,
        displayName: item.name,
        aliases:     item.aliases ?? [],
        lang:        'zh-HK' as const,
        category:    'whole_food' as const,
        per100g,
        defaultServingGrams,
        defaultServingUnit: '份',
        source:      'community' as const,
        accuracyTier,
        dataFreshnessDate: item.lastUpdated ?? item.updatedAt ?? new Date(),
        contributionCount: item.contributionCount ?? 0,
        nutritionFlags,
        searchCount: 0,
        logCount:    0,
        status:      'active' as const,
      };

      const result = await FoodItem.updateOne(
        { name: item.name },
        { $set: doc },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        created++;
      } else {
        updated++;
      }
    } catch (err) {
      console.error(`Error migrating "${item.name}":`, err);
      skipped++;
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${items.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
