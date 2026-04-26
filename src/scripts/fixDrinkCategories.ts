/**
 * One-time migration: fix 8 drink items misclassified as whole_food → drinks.
 *
 * Usage:
 *   npx ts-node -r dotenv/config src/scripts/fixDrinkCategories.ts
 */

import mongoose from 'mongoose';
import { FoodItem } from '../models/FoodItem';

const DRINK_IDS = [
  '69e402144327fafec6560e53', // high protein milk
  '69e7bba34a46ab1cc686be7a', // high protein 奶
  '69ed99838c659f7d8022ba90', // 凍奶茶
  '69e730d8695c2ac79df9a6f6', // 朱古力奶
  '69e939246254d674ee10bbae', // 椰奶
  '69e402154327fafec6560e56', // 熱奶茶
  '69e434b5f312b35dbcd0824e', // 牛奶
  '69e402174327fafec6560e5f', // 豆漿
];

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const result = await FoodItem.updateMany(
    { _id: { $in: DRINK_IDS } },
    { $set: { category: 'drinks' } }
  );

  console.log(`Updated ${result.modifiedCount} / ${DRINK_IDS.length} items to category: drinks`);

  // Verify
  const updated = await FoodItem.find({ _id: { $in: DRINK_IDS } }, 'displayName name category').lean();
  for (const item of updated) {
    console.log(`  ✓ [${item.category}] ${item.displayName || item.name}`);
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
