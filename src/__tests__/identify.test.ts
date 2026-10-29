import { normalizeIdentify } from '../utils/identify';

const base = {
  nameOriginal: 'Advanced Absorption Turmeric 500 mg',
  nameEnglish: null,
  brand: 'webber naturals',
  strength: '500 mg',
  unitForm: 'Capsules',
  packSize: 120,
  servingUnits: 2,
  timesPerDay: 1,
  directions: 'Recommended dosage (adults): 2 capsules daily or as directed by a physician.',
  sourceUrl: 'https://example.com/p/1',
  codeRead: 'NPN 80049256, UPC 625273051742',
  match: 'exact',
};

describe('normalizeIdentify', () => {
  it('keeps a good exact match and marks it usable', () => {
    const r = normalizeIdentify(base);
    expect(r).toMatchObject({ unitForm: 'capsule', packSize: 120, servingUnits: 2, timesPerDay: 1, match: 'exact', usable: true, brand: 'webber naturals' });
    expect(r.codes).toEqual(['NPN 80049256, UPC 625273051742']);
  });

  it('accepts "likely" too', () => {
    expect(normalizeIdentify({ ...base, match: 'likely' }).usable).toBe(true);
  });

  it('unsure → not usable and directions-derived fields are dropped', () => {
    const r = normalizeIdentify({ ...base, match: 'unsure' });
    expect(r.usable).toBe(false);
    expect(r.servingUnits).toBeNull();
    expect(r.timesPerDay).toBeNull();
    expect(r.directions).toBeNull();
    expect(r.nameOriginal).toBe(base.nameOriginal); // identification fields stay
  });

  it('no source page → not usable even if the model says exact', () => {
    for (const sourceUrl of [null, '', 'not a url', 'ftp://x/y', 'javascript:alert(1)']) {
      const r = normalizeIdentify({ ...base, sourceUrl });
      expect(r.usable).toBe(false);
      expect(r.servingUnits).toBeNull();
    }
  });

  it('unknown or missing match value → unsure', () => {
    expect(normalizeIdentify({ ...base, match: 'definitely' }).match).toBe('unsure');
    expect(normalizeIdentify({ ...base, match: undefined }).usable).toBe(false);
  });

  it('never trusts bad counts (range text, zero, negative, bottle-sized, non-numeric)', () => {
    for (const bad of ['1-3', 0, -2, 120, 'many', null, {}]) {
      expect(normalizeIdentify({ ...base, servingUnits: bad }).servingUnits).toBeNull();
    }
    expect(normalizeIdentify({ ...base, timesPerDay: 99 }).timesPerDay).toBeNull();
    expect(normalizeIdentify({ ...base, packSize: 'x' }).packSize).toBeNull();
  });

  it('normalises unit form and strings, caps lengths, tolerates junk', () => {
    expect(normalizeIdentify({ ...base, unitForm: 'lozenge' }).unitForm).toBeNull();
    expect(normalizeIdentify({ ...base, brand: '  Santen  ' }).brand).toBe('Santen');
    expect(normalizeIdentify({ ...base, directions: 'x'.repeat(2000) }).directions).toHaveLength(400);
    const junk = normalizeIdentify({ nameOriginal: 5, brand: [], codeRead: { a: 1 } } as unknown as Record<string, unknown>);
    expect(junk).toMatchObject({ nameOriginal: null, brand: null, codes: [], usable: false });
  });
});
