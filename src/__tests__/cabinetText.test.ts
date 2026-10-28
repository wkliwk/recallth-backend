import { parseCabinetTextFields, MAX_TEXT_LENGTH } from '../utils/cabinetText';

describe('parseCabinetTextFields', () => {
  it('returns nothing when the fields are absent, null or blank', () => {
    expect(parseCabinetTextFields({})).toEqual({ ok: true, value: {} });
    expect(parseCabinetTextFields(undefined)).toEqual({ ok: true, value: {} });
    expect(parseCabinetTextFields({ description: null, ingredients: '   ', imageUrl: '' })).toEqual({ ok: true, value: {} });
  });

  it('trims and keeps valid values', () => {
    expect(parseCabinetTextFields({ description: ' d ', ingredients: ' Curcumin 500 mg ', imageUrl: ' https://x.test/a.png ' })).toEqual({
      ok: true,
      value: { description: 'd', ingredients: 'Curcumin 500 mg', imageUrl: 'https://x.test/a.png' },
    });
  });

  it('accepts http(s) and data:image URLs only', () => {
    expect(parseCabinetTextFields({ imageUrl: 'http://x.test/a.png' }).ok).toBe(true);
    expect(parseCabinetTextFields({ imageUrl: 'data:image/png;base64,AAAA' }).ok).toBe(true);
    for (const bad of ['javascript:alert(1)', 'ftp://x/a.png', '/relative.png', 'data:text/html;base64,AAAA']) {
      expect(parseCabinetTextFields({ imageUrl: bad }).ok).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    for (const field of ['description', 'ingredients', 'imageUrl']) {
      for (const bad of [123, true, {}, []]) {
        const r = parseCabinetTextFields({ [field]: bad });
        expect(r.ok).toBe(false);
      }
    }
  });

  it('caps description and ingredients at the max length', () => {
    const r = parseCabinetTextFields({ ingredients: 'x'.repeat(MAX_TEXT_LENGTH + 500) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ingredients).toHaveLength(MAX_TEXT_LENGTH);
  });
});
