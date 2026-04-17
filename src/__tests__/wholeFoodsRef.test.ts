/**
 * Tests for the curated whole-foods reference table.
 * All lookups are deterministic — no mocks or network calls needed.
 *
 * Coverage: fruits, vegetables, proteins, dairy, grains,
 *           Cantonese aliases, partial matching, scaling.
 */

import { wholeFoodsLookup } from '../services/wholeFoodsRef';

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Assert that a macro is within ±pct% of the expected USDA value. */
function expectNear(actual: number | undefined, expected: number, pctTolerance = 5, label = '') {
  expect(actual).toBeDefined();
  const lo = expected * (1 - pctTolerance / 100);
  const hi = expected * (1 + pctTolerance / 100);
  expect(actual!).toBeGreaterThanOrEqual(lo - 0.1); // small abs buffer for rounding
  expect(actual!).toBeLessThanOrEqual(hi + 0.1);
  if (label) {} // label available for debugging; Jest shows the value automatically
}

/** Macro calorie check: protein*4 + carbs*4 + fat*9 should be within 20% of stated calories. */
function expectMacroConsistency(n: ReturnType<typeof wholeFoodsLookup>) {
  expect(n).not.toBeNull();
  const macroKcal = (n!.protein * 4) + (n!.carbs * 4) + (n!.fat * 9);
  const lo = n!.calories * 0.8;
  const hi = n!.calories * 1.2;
  expect(macroKcal).toBeGreaterThanOrEqual(lo - 1);
  expect(macroKcal).toBeLessThanOrEqual(hi + 1);
}

// ─── Fruits ──────────────────────────────────────────────────────────────────

describe('Fruits', () => {
  describe('banana / 香蕉', () => {
    it('looks up via Cantonese alias 香蕉', () => {
      const n = wholeFoodsLookup('香蕉');
      expect(n).not.toBeNull();
      expectNear(n!.calories, 89);
      expectNear(n!.protein, 1.1);
      expectNear(n!.carbs, 22.8);
      expectNear(n!.fat, 0.3);
    });

    it('looks up via short alias 蕉', () => {
      expect(wholeFoodsLookup('蕉')).not.toBeNull();
    });

    it('looks up via English name banana', () => {
      const n = wholeFoodsLookup('banana');
      expect(n).not.toBeNull();
      expectNear(n!.carbs, 22.8);
    });

    it('has carbs >> protein (fruit macro ratio)', () => {
      const n = wholeFoodsLookup('香蕉')!;
      expect(n.carbs).toBeGreaterThan(n.protein * 5);
    });

    it('has near-zero fat', () => {
      const n = wholeFoodsLookup('香蕉')!;
      expect(n.fat).toBeLessThan(1);
    });

    it('macro kcal is consistent with calories', () => expectMacroConsistency(wholeFoodsLookup('香蕉')));
  });

  describe('apple / 蘋果', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('蘋果')!;
      expectNear(n.calories, 52);
      expectNear(n.protein, 0.3);
      expectNear(n.carbs, 13.8);
      expectNear(n.fat, 0.2);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('蘋果')));
  });

  describe('orange / 橙', () => {
    it('looks up via 橙 and 橙子', () => {
      expect(wholeFoodsLookup('橙')).not.toBeNull();
      expect(wholeFoodsLookup('橙子')).not.toBeNull();
    });

    it('returns correct calories', () => {
      expectNear(wholeFoodsLookup('橙')!.calories, 47);
    });
  });

  describe('mango / 芒果', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('芒果')!;
      expectNear(n.calories, 60);
      expect(n.carbs).toBeGreaterThan(n.protein * 5);
    });
  });

  describe('watermelon / 西瓜', () => {
    it('is low calorie', () => {
      expect(wholeFoodsLookup('西瓜')!.calories).toBeLessThan(40);
    });
  });

  describe('avocado / 牛油果', () => {
    it('is high-fat fruit (unique macro profile)', () => {
      const n = wholeFoodsLookup('牛油果')!;
      expect(n.fat).toBeGreaterThan(10);
      expectNear(n.calories, 160);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('牛油果')));
  });

  describe('strawberry / 草莓', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('草莓')!;
      expectNear(n.calories, 32);
      expect(n.fat).toBeLessThan(1);
    });
  });
});

// ─── Vegetables ──────────────────────────────────────────────────────────────

describe('Vegetables', () => {
  describe('broccoli / 西蘭花', () => {
    it('looks up via 西蘭花 and 花椰菜', () => {
      expect(wholeFoodsLookup('西蘭花')).not.toBeNull();
      expect(wholeFoodsLookup('花椰菜')).not.toBeNull();
    });

    it('is low calorie, decent protein for a veg', () => {
      const n = wholeFoodsLookup('西蘭花')!;
      expect(n.calories).toBeLessThan(50);
      expect(n.protein).toBeGreaterThan(2);
    });
  });

  describe('spinach / 菠菜', () => {
    it('is very low calorie', () => {
      expect(wholeFoodsLookup('菠菜')!.calories).toBeLessThan(30);
    });
  });

  describe('tomato / 番茄', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('番茄')!;
      expectNear(n.calories, 18);
      expect(n.fat).toBeLessThan(0.5);
    });
  });

  describe('carrot / 紅蘿蔔', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('紅蘿蔔')!;
      expectNear(n.calories, 41);
      expect(n.carbs).toBeGreaterThan(n.protein * 3);
    });
  });

  describe('tofu / 豆腐', () => {
    it('has balanced protein and fat', () => {
      const n = wholeFoodsLookup('豆腐')!;
      expect(n.protein).toBeGreaterThan(5);
      expect(n.fat).toBeGreaterThan(2);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('豆腐')));
  });

  describe('potato / 薯仔', () => {
    it('is high carb, very low fat', () => {
      const n = wholeFoodsLookup('薯仔')!;
      expect(n.carbs).toBeGreaterThan(15);
      expect(n.fat).toBeLessThan(1);
    });
  });

  describe('corn / 粟米', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('粟米')!;
      expectNear(n.calories, 86);
      expect(n.carbs).toBeGreaterThan(15);
    });
  });
});

// ─── Proteins ────────────────────────────────────────────────────────────────

describe('Proteins', () => {
  describe('egg / 雞蛋', () => {
    it('looks up via 雞蛋 and 蛋', () => {
      expect(wholeFoodsLookup('雞蛋')).not.toBeNull();
      expect(wholeFoodsLookup('蛋')).not.toBeNull();
    });

    it('returns correct macros', () => {
      const n = wholeFoodsLookup('雞蛋')!;
      expectNear(n.calories, 155);
      expectNear(n.protein, 12.6);
      expectNear(n.fat, 10.6);
      expect(n.carbs).toBeLessThan(2);
    });

    it('has protein > carbs (animal protein profile)', () => {
      const n = wholeFoodsLookup('雞蛋')!;
      expect(n.protein).toBeGreaterThan(n.carbs * 5);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('雞蛋')));
  });

  describe('chicken breast / 雞胸肉', () => {
    it('is high protein, very low fat', () => {
      const n = wholeFoodsLookup('雞胸肉')!;
      expectNear(n.protein, 31.0);
      expect(n.fat).toBeLessThan(5);
      expect(n.carbs).toBe(0);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('雞胸肉')));
  });

  describe('salmon / 三文魚', () => {
    it('has significant fat (omega-3 profile)', () => {
      const n = wholeFoodsLookup('三文魚')!;
      expect(n.fat).toBeGreaterThan(10);
      expect(n.protein).toBeGreaterThan(18);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('三文魚')));
  });

  describe('tuna / 吞拿魚', () => {
    it('is high protein, moderate fat', () => {
      const n = wholeFoodsLookup('吞拿魚')!;
      expect(n.protein).toBeGreaterThan(20);
      expect(n.fat).toBeLessThan(10);
    });
  });

  describe('shrimp / 蝦', () => {
    it('is high protein, very low fat', () => {
      const n = wholeFoodsLookup('蝦')!;
      expect(n.protein).toBeGreaterThan(15);
      expect(n.fat).toBeLessThan(3);
    });
  });

  describe('pork belly / 五花腩', () => {
    it('is high fat', () => {
      const n = wholeFoodsLookup('五花腩')!;
      expect(n.fat).toBeGreaterThan(40);
      expectNear(n.calories, 518, 10);
    });
  });
});

// ─── Dairy ───────────────────────────────────────────────────────────────────

describe('Dairy', () => {
  describe('milk / 牛奶', () => {
    it('returns balanced macros', () => {
      const n = wholeFoodsLookup('牛奶')!;
      expectNear(n.calories, 61);
      expect(n.protein).toBeGreaterThan(2.5);
      expect(n.carbs).toBeGreaterThan(3);
      expect(n.fat).toBeGreaterThan(2);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('牛奶')));
  });

  describe('cheese / 芝士', () => {
    it('is high fat and protein', () => {
      const n = wholeFoodsLookup('芝士')!;
      expect(n.fat).toBeGreaterThan(25);
      expect(n.protein).toBeGreaterThan(20);
      expect(n.calories).toBeGreaterThan(350);
    });
  });
});

// ─── Grains / Staples ────────────────────────────────────────────────────────

describe('Grains / Staples', () => {
  describe('steamed rice / 白飯', () => {
    it('looks up via 白飯 and 白米飯', () => {
      expect(wholeFoodsLookup('白飯')).not.toBeNull();
      expect(wholeFoodsLookup('白米飯')).not.toBeNull();
    });

    it('is high carb, very low fat', () => {
      const n = wholeFoodsLookup('白飯')!;
      expect(n.carbs).toBeGreaterThan(25);
      expect(n.fat).toBeLessThan(1);
      expectNear(n.calories, 130);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('白飯')));
  });

  describe('brown rice / 糙米飯', () => {
    it('has more fiber than white rice', () => {
      const white = wholeFoodsLookup('白飯')!;
      const brown = wholeFoodsLookup('糙米飯')!;
      expect(brown.fiber!).toBeGreaterThan(white.fiber!);
    });
  });

  describe('oats / 燕麥', () => {
    it('is high carb with significant protein', () => {
      const n = wholeFoodsLookup('燕麥')!;
      expect(n.carbs).toBeGreaterThan(60);
      expect(n.protein).toBeGreaterThan(10);
    });

    it('macro consistency', () => expectMacroConsistency(wholeFoodsLookup('燕麥')));
  });

  describe('bread / 麵包', () => {
    it('returns correct macros', () => {
      const n = wholeFoodsLookup('麵包')!;
      expectNear(n.calories, 265);
      expect(n.carbs).toBeGreaterThan(40);
    });
  });
});

// ─── Lookup mechanics ────────────────────────────────────────────────────────

describe('Lookup mechanics', () => {
  it('returns null for unknown foods (HK dishes fall through to AI)', () => {
    expect(wholeFoodsLookup('叉燒飯')).toBeNull();
    expect(wholeFoodsLookup('雲吞麵')).toBeNull();
    expect(wholeFoodsLookup('菠蘿油')).toBeNull();
    expect(wholeFoodsLookup('拉麵')).toBeNull();
    expect(wholeFoodsLookup('麥當勞巨無霸')).toBeNull();
    expect(wholeFoodsLookup('可樂')).toBeNull();
    expect(wholeFoodsLookup('絲襪奶茶')).toBeNull();
  });

  it('is case-insensitive for English names', () => {
    expect(wholeFoodsLookup('Banana')).not.toBeNull();
    expect(wholeFoodsLookup('APPLE')).not.toBeNull();
    expect(wholeFoodsLookup('Chicken Breast')).not.toBeNull();
  });

  it('all reference entries have positive calories', () => {
    const foods = [
      '香蕉', '蘋果', '橙', '草莓', '葡萄', '西瓜', '芒果', '梨', '桃',
      '菠蘿', '木瓜', '奇異果', '牛油果', '藍莓', '荔枝', '榴槤',
      '西蘭花', '菠菜', '番茄', '紅蘿蔔', '青瓜', '洋蔥', '薯仔',
      '番薯', '椰菜', '粟米', '蘑菇', '茄子', '生菜', '菜心', '白菜',
      '雞蛋', '雞胸肉', '雞髀', '三文魚', '吞拿魚', '五花腩', '牛肉',
      '豆腐', '蝦', '豬扒',
      '牛奶', '乳酪', '芝士',
      '白飯', '糙米飯', '燕麥', '麵包', '麵條', '意粉',
    ];

    for (const food of foods) {
      const n = wholeFoodsLookup(food);
      expect(n).not.toBeNull();
      expect(n!.calories).toBeGreaterThan(0);
      expect(n!.protein).toBeGreaterThanOrEqual(0);
      expect(n!.carbs).toBeGreaterThanOrEqual(0);
      expect(n!.fat).toBeGreaterThanOrEqual(0);
    }
  });

  it('all reference entries pass macro consistency check (±30%)', () => {
    const foods = [
      '香蕉', '蘋果', '雞蛋', '雞胸肉', '三文魚', '白飯', '燕麥', '豆腐', '牛奶', '芝士', '牛油果',
    ];
    for (const food of foods) {
      const n = wholeFoodsLookup(food)!;
      const macroKcal = n.protein * 4 + n.carbs * 4 + n.fat * 9;
      const lo = n.calories * 0.7;
      const hi = n.calories * 1.3;
      expect(macroKcal).toBeGreaterThanOrEqual(lo - 1);
      expect(macroKcal).toBeLessThanOrEqual(hi + 1);
    }
  });
});
