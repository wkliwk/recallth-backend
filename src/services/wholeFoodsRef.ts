/**
 * Curated whole-foods reference table — per 100g, USDA-sourced values.
 * Checked FIRST before OFF lookup and AI estimate for common unprocessed foods.
 * Keys are lowercase; lookup normalises input before matching.
 */

export interface WholeFoodNutrients {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  sugar?: number;
  fiber?: number;
  sodium?: number;
}

// All values per 100g
const WHOLE_FOODS_PER_100G: Record<string, WholeFoodNutrients> = {
  // ── Fruits ───────────────────────────────────────────────────────────────
  banana: { calories: 89, protein: 1.1, carbs: 22.8, fat: 0.3, sugar: 12.2, fiber: 2.6, sodium: 1 },
  apple: { calories: 52, protein: 0.3, carbs: 13.8, fat: 0.2, sugar: 10.4, fiber: 2.4, sodium: 1 },
  orange: { calories: 47, protein: 0.9, carbs: 11.8, fat: 0.1, sugar: 9.4, fiber: 2.4, sodium: 0 },
  strawberry: { calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, sugar: 4.9, fiber: 2.0, sodium: 1 },
  grape: { calories: 69, protein: 0.7, carbs: 18.1, fat: 0.2, sugar: 15.5, fiber: 0.9, sodium: 2 },
  watermelon: { calories: 30, protein: 0.6, carbs: 7.6, fat: 0.2, sugar: 6.2, fiber: 0.4, sodium: 1 },
  mango: { calories: 60, protein: 0.8, carbs: 15.0, fat: 0.4, sugar: 13.7, fiber: 1.6, sodium: 1 },
  pear: { calories: 57, protein: 0.4, carbs: 15.2, fat: 0.1, sugar: 9.8, fiber: 3.1, sodium: 1 },
  peach: { calories: 39, protein: 0.9, carbs: 9.5, fat: 0.3, sugar: 8.4, fiber: 1.5, sodium: 0 },
  pineapple: { calories: 50, protein: 0.5, carbs: 13.1, fat: 0.1, sugar: 9.9, fiber: 1.4, sodium: 1 },
  papaya: { calories: 43, protein: 0.5, carbs: 10.8, fat: 0.3, sugar: 7.8, fiber: 1.7, sodium: 8 },
  kiwi: { calories: 61, protein: 1.1, carbs: 14.7, fat: 0.5, sugar: 9.0, fiber: 3.0, sodium: 3 },
  avocado: { calories: 160, protein: 2.0, carbs: 8.5, fat: 14.7, sugar: 0.7, fiber: 6.7, sodium: 7 },
  blueberry: { calories: 57, protein: 0.7, carbs: 14.5, fat: 0.3, sugar: 10.0, fiber: 2.4, sodium: 1 },
  lychee: { calories: 66, protein: 0.8, carbs: 16.5, fat: 0.4, sugar: 15.2, fiber: 1.3, sodium: 1 },
  durian: { calories: 147, protein: 1.5, carbs: 27.1, fat: 5.3, sugar: 6.8, fiber: 3.8, sodium: 2 },

  // ── Vegetables ───────────────────────────────────────────────────────────
  broccoli: { calories: 34, protein: 2.8, carbs: 6.6, fat: 0.4, sugar: 1.7, fiber: 2.6, sodium: 33 },
  spinach: { calories: 23, protein: 2.9, carbs: 3.6, fat: 0.4, sugar: 0.4, fiber: 2.2, sodium: 79 },
  tomato: { calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, sugar: 2.6, fiber: 1.2, sodium: 5 },
  carrot: { calories: 41, protein: 0.9, carbs: 9.6, fat: 0.2, sugar: 4.7, fiber: 2.8, sodium: 69 },
  cucumber: { calories: 15, protein: 0.7, carbs: 3.6, fat: 0.1, sugar: 1.7, fiber: 0.5, sodium: 2 },
  onion: { calories: 40, protein: 1.1, carbs: 9.3, fat: 0.1, sugar: 4.2, fiber: 1.7, sodium: 4 },
  potato: { calories: 77, protein: 2.0, carbs: 17.5, fat: 0.1, sugar: 0.8, fiber: 2.2, sodium: 6 },
  sweetpotato: { calories: 86, protein: 1.6, carbs: 20.1, fat: 0.1, sugar: 4.2, fiber: 3.0, sodium: 55 },
  cabbage: { calories: 25, protein: 1.3, carbs: 5.8, fat: 0.1, sugar: 3.2, fiber: 2.5, sodium: 18 },
  corn: { calories: 86, protein: 3.3, carbs: 19.0, fat: 1.4, sugar: 3.2, fiber: 2.7, sodium: 15 },
  mushroom: { calories: 22, protein: 3.1, carbs: 3.3, fat: 0.3, sugar: 2.0, fiber: 1.0, sodium: 5 },
  eggplant: { calories: 25, protein: 1.0, carbs: 5.9, fat: 0.2, sugar: 3.5, fiber: 3.0, sodium: 2 },
  lettuce: { calories: 15, protein: 1.4, carbs: 2.9, fat: 0.2, sugar: 1.2, fiber: 1.3, sodium: 28 },
  'choy sum': { calories: 20, protein: 1.8, carbs: 2.8, fat: 0.3, fiber: 1.2, sodium: 30 },
  'bok choy': { calories: 13, protein: 1.5, carbs: 2.2, fat: 0.2, sugar: 1.2, fiber: 1.0, sodium: 65 },

  // ── Proteins ─────────────────────────────────────────────────────────────
  egg: { calories: 155, protein: 12.6, carbs: 1.1, fat: 10.6, sugar: 1.1, sodium: 124 },
  'chicken breast': { calories: 165, protein: 31.0, carbs: 0, fat: 3.6, sodium: 74 },
  'chicken thigh': { calories: 209, protein: 26.0, carbs: 0, fat: 10.9, sodium: 84 },
  salmon: { calories: 208, protein: 20.4, carbs: 0, fat: 13.4, sodium: 59 },
  tuna: { calories: 144, protein: 23.3, carbs: 0, fat: 4.9, sodium: 50 },
  'pork belly': { calories: 518, protein: 9.3, carbs: 0, fat: 53.0, sodium: 34 },
  beef: { calories: 250, protein: 26.1, carbs: 0, fat: 15.5, sodium: 72 },
  tofu: { calories: 76, protein: 8.1, carbs: 1.9, fat: 4.2, sugar: 0.3, fiber: 0.3, sodium: 7 },
  shrimp: { calories: 99, protein: 18.0, carbs: 0.9, fat: 1.4, sodium: 111 },
  'pork chop': { calories: 231, protein: 25.7, carbs: 0, fat: 13.4, sodium: 58 },

  // ── Dairy ────────────────────────────────────────────────────────────────
  milk: { calories: 61, protein: 3.2, carbs: 4.8, fat: 3.3, sugar: 4.8, sodium: 44 },
  yogurt: { calories: 59, protein: 3.5, carbs: 5.0, fat: 3.3, sugar: 5.0, sodium: 46 },
  cheese: { calories: 402, protein: 25.0, carbs: 1.3, fat: 33.0, sodium: 621 },

  // ── Grains / Staples ─────────────────────────────────────────────────────
  'steamed rice': { calories: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4, sodium: 1 },
  'brown rice': { calories: 123, protein: 2.7, carbs: 25.6, fat: 1.0, fiber: 1.8, sodium: 4 },
  oats: { calories: 389, protein: 16.9, carbs: 66.3, fat: 6.9, fiber: 10.6, sodium: 2 },
  bread: { calories: 265, protein: 9.0, carbs: 49.0, fat: 3.2, fiber: 2.7, sodium: 491 },
  noodles: { calories: 138, protein: 4.5, carbs: 25.0, fat: 2.1, fiber: 1.8, sodium: 132 },
  pasta: { calories: 158, protein: 5.8, carbs: 30.9, fat: 0.9, fiber: 1.8, sodium: 1 },
};

// Aliases for common HK Cantonese names → English key in WHOLE_FOODS_PER_100G
const ALIASES: Record<string, string> = {
  // Fruits
  香蕉: 'banana',
  蕉: 'banana',
  蘋果: 'apple',
  橙: 'orange',
  橙子: 'orange',
  草莓: 'strawberry',
  葡萄: 'grape',
  西瓜: 'watermelon',
  芒果: 'mango',
  梨: 'pear',
  桃: 'peach',
  菠蘿: 'pineapple',
  木瓜: 'papaya',
  奇異果: 'kiwi',
  牛油果: 'avocado',
  藍莓: 'blueberry',
  荔枝: 'lychee',
  榴槤: 'durian',
  // Vegetables
  西蘭花: 'broccoli',
  花椰菜: 'broccoli',
  菠菜: 'spinach',
  番茄: 'tomato',
  紅蘿蔔: 'carrot',
  青瓜: 'cucumber',
  洋蔥: 'onion',
  薯仔: 'potato',
  番薯: 'sweetpotato',
  椰菜: 'cabbage',
  粟米: 'corn',
  蘑菇: 'mushroom',
  茄子: 'eggplant',
  生菜: 'lettuce',
  菜心: 'choy sum',
  白菜: 'bok choy',
  // Proteins
  雞蛋: 'egg',
  蛋: 'egg',
  雞胸肉: 'chicken breast',
  雞髀: 'chicken thigh',
  三文魚: 'salmon',
  吞拿魚: 'tuna',
  五花腩: 'pork belly',
  牛肉: 'beef',
  豆腐: 'tofu',
  蝦: 'shrimp',
  豬扒: 'pork chop',
  // Dairy
  牛奶: 'milk',
  乳酪: 'yogurt',
  芝士: 'cheese',
  // Grains
  白飯: 'steamed rice',
  白米飯: 'steamed rice',
  糙米飯: 'brown rice',
  燕麥: 'oats',
  麵包: 'bread',
  麵條: 'noodles',
  意粉: 'pasta',
};

/**
 * Look up a food by name in the curated whole-foods table.
 * Returns per-100g nutrients, or null if not found.
 *
 * Intentionally strict: only exact matches. Dish names that happen to contain
 * a whole-food word (e.g. 菠蘿油 contains 菠蘿) must NOT match — they are
 * composite dishes and should fall through to AI estimation.
 */
export function wholeFoodsLookup(name: string): WholeFoodNutrients | null {
  const normalised = name.trim().toLowerCase();

  // 1. Direct English match (case-insensitive)
  if (WHOLE_FOODS_PER_100G[normalised]) return WHOLE_FOODS_PER_100G[normalised];

  // 2. Exact Chinese alias match
  const englishKey = ALIASES[name.trim()];
  if (englishKey && WHOLE_FOODS_PER_100G[englishKey]) return WHOLE_FOODS_PER_100G[englishKey];

  return null;
}
