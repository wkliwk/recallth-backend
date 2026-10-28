import { parsePurchaseFields } from '../utils/purchase';

describe('parsePurchaseFields', () => {
  it('leaves absent fields out (no change)', () => {
    expect(parsePurchaseFields({})).toEqual({ ok: true, value: {} });
    expect(parsePurchaseFields(undefined)).toEqual({ ok: true, value: {} });
  });

  it('accepts a number, numeric string and zero', () => {
    expect(parsePurchaseFields({ purchasePrice: 128.5 })).toEqual({ ok: true, value: { purchasePrice: 128.5 } });
    expect(parsePurchaseFields({ purchasePrice: '19.99' })).toEqual({ ok: true, value: { purchasePrice: 19.99 } });
    expect(parsePurchaseFields({ purchasePrice: 0 })).toEqual({ ok: true, value: { purchasePrice: 0 } });
  });

  it('treats null and empty string as clear', () => {
    expect(parsePurchaseFields({ purchasePrice: null, purchaseDate: null })).toEqual({
      ok: true,
      value: { purchasePrice: null, purchaseDate: null },
    });
    expect(parsePurchaseFields({ purchasePrice: '', purchaseDate: '  ' })).toEqual({
      ok: true,
      value: { purchasePrice: null, purchaseDate: null },
    });
  });

  it('rejects negative, non-numeric and non-finite prices', () => {
    for (const bad of [-1, 'abc', NaN, Infinity, {}, [], true]) {
      const r = parsePurchaseFields({ purchasePrice: bad as unknown });
      expect(r.ok).toBe(false);
    }
  });

  it('parses valid dates and rejects invalid ones', () => {
    const ok = parsePurchaseFields({ purchaseDate: '2026-10-20' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.purchaseDate?.toISOString().startsWith('2026-10-20')).toBe(true);
    for (const bad of ['not a date', {}, [], true]) {
      expect(parsePurchaseFields({ purchaseDate: bad as unknown }).ok).toBe(false);
    }
  });
});
