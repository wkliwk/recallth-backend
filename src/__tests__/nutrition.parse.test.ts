import { parseAiNutritionResponse } from '../utils/parseNutritionResponse';

describe('parseAiNutritionResponse', () => {
  // ── Compound dish splitting ──────────────────────────────────────────────
  describe('compound dish splitting', () => {
    it('splits 雞扒炒烏冬 + 雞球 into two separate food items', () => {
      const aiResponse = JSON.stringify({
        foods: [
          { name: '炒烏冬', quantity: 1, unit: '份', nutrients: { calories: 420, protein: 12, carbs: 68, fat: 10 } },
          { name: '雞球', quantity: 10, unit: '粒', nutrients: { calories: 300, protein: 28, carbs: 8, fat: 18 } },
        ],
        suggestions: [],
      });

      const result = parseAiNutritionResponse(aiResponse);

      expect(result).not.toBeNull();
      expect(result!.foods).toHaveLength(2);
      expect((result!.foods[0] as { name: string }).name).toBe('炒烏冬');
      expect((result!.foods[1] as { name: string }).name).toBe('雞球');
    });

    it('preserves quantity of 10粒 for chicken balls', () => {
      const aiResponse = JSON.stringify({
        foods: [
          { name: '炒烏冬', quantity: 1, unit: '份', nutrients: { calories: 420, protein: 12, carbs: 68, fat: 10 } },
          { name: '雞球', quantity: 10, unit: '粒', nutrients: { calories: 300, protein: 28, carbs: 8, fat: 18 } },
        ],
        suggestions: [],
      });

      const result = parseAiNutritionResponse(aiResponse);

      const chickenBalls = result!.foods[1] as { quantity: number; unit: string };
      expect(chickenBalls.quantity).toBe(10);
      expect(chickenBalls.unit).toBe('粒');
    });
  });

  // ── Set meal detection ───────────────────────────────────────────────────
  describe('set meal with drink suggestions', () => {
    it('returns fixed foods and drink suggestions separately', () => {
      const aiResponse = JSON.stringify({
        foods: [
          { name: '麥當勞豬柳蛋漢堡', quantity: 1, unit: '份', nutrients: { calories: 430, protein: 19, carbs: 35, fat: 24 } },
          { name: '麥當勞薯餅', quantity: 1, unit: '份', nutrients: { calories: 140, protein: 1.5, carbs: 15, fat: 8 } },
        ],
        suggestions: [
          { name: '麥當勞咖啡', quantity: 1, unit: '杯', nutrients: { calories: 80, protein: 3, carbs: 10, fat: 3 } },
          { name: '麥當勞奶茶', quantity: 1, unit: '杯', nutrients: { calories: 90, protein: 3, carbs: 12, fat: 3 } },
        ],
      });

      const result = parseAiNutritionResponse(aiResponse);

      expect(result!.foods).toHaveLength(2);
      expect(result!.suggestions).toHaveLength(2);
    });
  });

  // ── Single item ──────────────────────────────────────────────────────────
  describe('single item', () => {
    it('returns one food item with empty suggestions', () => {
      const aiResponse = JSON.stringify({
        foods: [{ name: '叉燒飯', quantity: 1, unit: '碟', nutrients: { calories: 650, protein: 28, carbs: 80, fat: 18 } }],
        suggestions: [],
      });

      const result = parseAiNutritionResponse(aiResponse);

      expect(result!.foods).toHaveLength(1);
      expect(result!.suggestions).toHaveLength(0);
    });
  });

  // ── Legacy array format ──────────────────────────────────────────────────
  describe('legacy array format', () => {
    it('handles array response as all confirmed foods', () => {
      const aiResponse = JSON.stringify([
        { name: '叉燒飯', quantity: 1, unit: '碟', nutrients: { calories: 650, protein: 28, carbs: 80, fat: 18 } },
      ]);

      const result = parseAiNutritionResponse(aiResponse);

      expect(result!.foods).toHaveLength(1);
      expect(result!.suggestions).toHaveLength(0);
    });
  });

  // ── Malformed / unexpected format ────────────────────────────────────────
  describe('malformed responses', () => {
    it('returns null when AI response has no JSON', () => {
      const result = parseAiNutritionResponse('Sorry, I cannot help with that.');
      expect(result).toBeNull();
    });

    it('returns null when response is empty', () => {
      const result = parseAiNutritionResponse('');
      expect(result).toBeNull();
    });

    it('returns empty foods array when object has no foods key', () => {
      const result = parseAiNutritionResponse(JSON.stringify({ something: 'else' }));
      expect(result!.foods).toHaveLength(0);
      expect(result!.suggestions).toHaveLength(0);
    });
  });

  // ── JSON embedded in markdown ────────────────────────────────────────────
  describe('JSON wrapped in markdown', () => {
    it('extracts JSON even when wrapped in markdown code block', () => {
      const aiResponse = `Here is the data:\n\`\`\`json\n${JSON.stringify({
        foods: [{ name: '叉燒飯', quantity: 1, unit: '碟', nutrients: { calories: 650, protein: 28, carbs: 80, fat: 18 } }],
        suggestions: [],
      })}\n\`\`\``;

      const result = parseAiNutritionResponse(aiResponse);

      expect(result).not.toBeNull();
      expect(result!.foods).toHaveLength(1);
    });
  });
});
