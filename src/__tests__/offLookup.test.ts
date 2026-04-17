/**
 * Tests for offLookup service.
 * We mock the MongoDB model and global fetch to avoid real network calls.
 */

jest.mock('../models/NutritionOffCache', () => ({
  NutritionOffCache: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

import { NutritionOffCache } from '../models/NutritionOffCache';
import { offLookup } from '../services/offLookup';

const mockFindOne = NutritionOffCache.findOne as jest.Mock;
const mockFindOneAndUpdate = NutritionOffCache.findOneAndUpdate as jest.Mock;

function makeOffResponse(productName: string, nutriments: Record<string, number>) {
  return {
    ok: true,
    json: async () => ({ products: [{ product_name: productName, nutriments }] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  mockFindOneAndUpdate.mockResolvedValue(null);
});

describe('offLookup', () => {
  // ── Cache hit ────────────────────────────────────────────────────────────
  describe('cache hit', () => {
    it('returns scaled nutrients from cache without fetching OFF', async () => {
      mockFindOne.mockReturnValue({
        lean: () => Promise.resolve({
          query: '白飯',
          offProductName: 'White Rice',
          per100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3 },
          fetchedAt: new Date(),
        }),
      });

      global.fetch = jest.fn();

      const result = await offLookup('白飯', 1, '碗');

      expect(result).not.toBeNull();
      expect(result!.productName).toBe('White Rice');
      // 1 碗 = 350g → calories = 130 * 3.5 = 455
      expect(result!.scaledNutrients.calories).toBe(455);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── OFF fetch success ────────────────────────────────────────────────────
  describe('OFF fetch success', () => {
    it('returns scaled nutrients from OFF and saves to cache', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        makeOffResponse('Egg', {
          'energy-kcal_100g': 155,
          proteins_100g: 13,
          carbohydrates_100g: 1.1,
          fat_100g: 11,
        })
      );

      const result = await offLookup('雞蛋', 1, '個');

      expect(result).not.toBeNull();
      expect(result!.productName).toBe('Egg');
      // 1 個 = 120g → calories = 155 * 1.2 = 186
      expect(result!.scaledNutrients.calories).toBe(186);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('returns null when OFF product has no calories', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ products: [{ product_name: 'Mystery Food', nutriments: {} }] }),
      });

      const result = await offLookup('unknownfood', 1, '份');
      expect(result).toBeNull();
    });
  });

  // ── OFF unavailable (graceful fallback) ──────────────────────────────────
  describe('OFF unavailable', () => {
    it('returns null when OFF returns non-ok status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false });
      const result = await offLookup('anything', 1, '份');
      expect(result).toBeNull();
    });

    it('returns null when fetch throws (timeout / network error)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network timeout'));
      const result = await offLookup('anything', 1, '份');
      expect(result).toBeNull();
    });

    it('returns null when OFF returns empty products array', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ products: [] }),
      });
      const result = await offLookup('anything', 1, '份');
      expect(result).toBeNull();
    });
  });

  // ── Unit weight scaling ──────────────────────────────────────────────────
  describe('unit scaling', () => {
    it('scales correctly for 粒 unit (15g each)', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        makeOffResponse('Wonton', { 'energy-kcal_100g': 100, proteins_100g: 5, carbohydrates_100g: 10, fat_100g: 3 })
      );

      const result = await offLookup('雲吞', 5, '粒');
      // 5 粒 × 15g = 75g → calories = 100 * 0.75 = 75
      expect(result!.scaledNutrients.calories).toBe(75);
    });

    it('scales correctly for g unit (direct)', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce(
        makeOffResponse('Rice', { 'energy-kcal_100g': 130, proteins_100g: 2.7, carbohydrates_100g: 28, fat_100g: 0.3 })
      );

      const result = await offLookup('白飯', 200, 'g');
      // 200g → calories = 130 * 2 = 260
      expect(result!.scaledNutrients.calories).toBe(260);
    });
  });
});
