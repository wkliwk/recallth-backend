import { normalizeDoseFields, normalizeUnitForm, normalizeCount, composeLegacyDosage } from '../utils/dose';

describe('normalizeCount', () => {
  it('accepts positive numbers and numeric strings', () => {
    expect(normalizeCount(2)).toBe(2);
    expect(normalizeCount('120')).toBe(120);
  });
  it('rejects zero, negative, text, NaN, huge — never assumes 1', () => {
    for (const bad of [0, -1, 'abc', NaN, null, undefined, {}, [], 1e9]) {
      expect(normalizeCount(bad as unknown)).toBeNull();
    }
  });
});

describe('normalizeUnitForm', () => {
  it('maps common names and french/plural variants', () => {
    expect(normalizeUnitForm('Capsules')).toBe('capsule');
    expect(normalizeUnitForm('vegetarian capsules')).toBe('capsule');
    expect(normalizeUnitForm('gélules')).toBe('capsule');
    expect(normalizeUnitForm('Soft Gels')).toBe('softgel');
    expect(normalizeUnitForm('gummies')).toBe('gummy');
    expect(normalizeUnitForm('lozenge')).toBeNull();
    expect(normalizeUnitForm(null)).toBeNull();
  });
});

describe('normalizeDoseFields', () => {
  it('front-of-bottle label: strength + bottleCount, no serving count', () => {
    expect(normalizeDoseFields({ strength: ' 500 mg ', unitForm: 'capsule', servingUnits: null, bottleCount: 120 })).toEqual({
      strength: '500 mg', unitForm: 'capsule', servingUnits: null, bottleCount: 120,
    });
  });
  it('caps servingUnits at a sane per-dose number', () => {
    expect(normalizeDoseFields({ servingUnits: 120 }).servingUnits).toBeNull();
    expect(normalizeDoseFields({ servingUnits: 2 }).servingUnits).toBe(2);
  });
});

describe('composeLegacyDosage', () => {
  it('uses the strength when the per-dose count is unknown', () => {
    expect(composeLegacyDosage({ strength: '500 mg', unitForm: 'capsule', servingUnits: null, bottleCount: 120 })).toBe('500 mg');
  });
  it('composes count + strength when known, singular for 1', () => {
    expect(composeLegacyDosage({ strength: '500 mg', unitForm: 'capsule', servingUnits: 2, bottleCount: null })).toBe('2 capsules (500 mg each)');
    expect(composeLegacyDosage({ strength: '500 mg', unitForm: 'capsule', servingUnits: 1, bottleCount: null })).toBe('1 capsule (500 mg each)');
  });
  it('falls back to the model dosage text, then null', () => {
    expect(composeLegacyDosage({ strength: null, unitForm: null, servingUnits: null, bottleCount: null }, '1 scoop')).toBe('1 scoop');
    expect(composeLegacyDosage({ strength: null, unitForm: null, servingUnits: null, bottleCount: null })).toBeNull();
  });
});
