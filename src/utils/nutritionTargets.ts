import type { NutritionCategory } from '../models/Nutrition';

export interface NutrientTarget {
  nutrient: string;
  unit: string;
  dailyTarget: number;
  type: 'min' | 'max';
}

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
