import { cleanReferenceUrl, classifyReference, rankReferences, parseReferences, buildReferences, Reference } from '../utils/references';
import type { SafeResponse } from '../utils/safeFetch';

const resp = (status: number, body: string, url: string): SafeResponse => {
  const b = Buffer.from(body);
  return { status, ok: status >= 200 && status < 300, headers: {}, body: b, url, truncated: false, text: () => b.toString('utf8') };
};

describe('cleanReferenceUrl', () => {
  it('keeps http(s), strips fragment and tracking params, rejects the rest', () => {
    expect(cleanReferenceUrl('https://shop.example.com/p/1?id=5&utm_source=x&gclid=abc&ref=home#reviews')).toBe('https://shop.example.com/p/1?id=5');
    expect(cleanReferenceUrl(' http://example.com/a ')).toBe('http://example.com/a');
    for (const bad of ['javascript:alert(1)', 'ftp://x/y', 'data:text/html,hi', 'https://u:p@example.com/', 'nope', '', 123, null]) {
      expect(cleanReferenceUrl(bad as unknown)).toBeNull();
    }
    expect(cleanReferenceUrl(`https://example.com/${'a'.repeat(2100)}`)).toBeNull();
  });
});

describe('classifyReference', () => {
  it('official: the brand is a domain label', () => {
    expect(classifyReference('https://www.webbernaturals.com/products/turmeric', 'webber naturals')).toBe('official');
    expect(classifyReference('https://www.santen.com/en/', 'Santen')).toBe('official');
    expect(classifyReference('https://www.uha-mikakuto.co.jp/products/x', 'UHA')).toBe('official');
    expect(classifyReference('https://www.nowfoods.com/products/x', 'NOW Foods')).toBe('official');
  });
  it('database: government / regulatory domains', () => {
    expect(classifyReference('https://health-products.canada.ca/lnhpd-bdpsnh/info.do?licence=1', 'x')).toBe('database');
    expect(classifyReference('https://dailymed.nlm.nih.gov/dailymed/x', 'x')).toBe('database');
    expect(classifyReference('https://www.mhlw.go.jp/x', 'x')).toBe('database');
    expect(classifyReference('https://www.fda.gov/x', 'x')).toBe('database');
  });
  it('retailer: a known list; the brand name does not turn a retailer into "official"', () => {
    expect(classifyReference('https://ca.iherb.com/pr/x/1', 'iHerb')).toBe('retailer'); // brand equals a retailer domain → still retailer
    expect(classifyReference('https://www.costco.ca/p/-/x/1', 'webber naturals')).toBe('retailer');
    expect(classifyReference('https://www.amazon.co.jp/dp/B0', 'UHA')).toBe('retailer');
  });
  it('other: blogs / unknown sites, and short or missing brands cannot make "official"', () => {
    expect(classifyReference('https://best-supplement-reviews.example.org/turmeric', 'webber naturals')).toBe('other');
    expect(classifyReference('https://know.example.com/', 'NOW')).toBe('other'); // "now" is not a label by itself
    expect(classifyReference('https://somesite.com/', null)).toBe('other');
    expect(classifyReference('not a url', 'x')).toBe('other');
  });
});

describe('rankReferences', () => {
  const r = (url: string, kind: Reference['kind']): Reference => ({ url, title: url, kind });
  it('sorts official > database > retailer > other and caps', () => {
    const out = rankReferences([r('a', 'other'), r('b', 'retailer'), r('c', 'official'), r('d', 'database'), r('e', 'retailer'), r('f', 'retailer'), r('g', 'retailer')]);
    expect(out.map((x) => x.url)).toEqual(['c', 'd', 'b', 'e', 'f']);
  });
  it('keeps "other" only to fill up to 2 slots when there are few good sources', () => {
    expect(rankReferences([r('o1', 'other'), r('o2', 'other'), r('o3', 'other')]).map((x) => x.url)).toEqual(['o1', 'o2']);
    expect(rankReferences([r('o1', 'other'), r('c', 'official'), r('o2', 'other')]).map((x) => x.url)).toEqual(['c', 'o1']);
    expect(rankReferences([r('o1', 'other'), r('c', 'official'), r('b', 'retailer')]).map((x) => x.url)).toEqual(['c', 'b']);
  });
});

describe('parseReferences', () => {
  it('accepts a valid list, cleans urls, defaults title and kind, dedupes', () => {
    const r = parseReferences([{ url: 'https://www.santen.com/a?utm_x=1', title: '  Santen  ', kind: 'official' }, { url: 'https://www.santen.com/a' }]);
    expect(r).toEqual({ ok: true, value: [{ url: 'https://www.santen.com/a', title: 'Santen', kind: 'official' }] });
    const d = parseReferences([{ url: 'https://shop.example.com/p', kind: 'weird' }]);
    expect(d.ok && d.value[0]).toEqual({ url: 'https://shop.example.com/p', title: 'shop.example.com', kind: 'other' });
  });
  it('an empty array is valid (clears)', () => {
    expect(parseReferences([])).toEqual({ ok: true, value: [] });
  });
  it('rejects non-arrays, bad items, unsafe urls and more than 5', () => {
    for (const bad of ['x', {}, null, [null], ['https://x.test'], [{ url: 'javascript:alert(1)' }], [{ title: 'no url' }]]) {
      expect(parseReferences(bad as unknown).ok).toBe(false);
    }
    const six = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.com/${i}` }));
    expect(parseReferences(six).ok).toBe(false);
  });
});

describe('buildReferences', () => {
  const html = (t: string) => `<html><head><title>${t}</title></head></html>`;
  it('resolves grounding redirects to final URLs with page titles, classifies and ranks them', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.includes('redirect/1')) return resp(200, html('Advanced Turmeric | Webber Naturals'), 'https://www.webbernaturals.com/products/turmeric?utm_source=g');
      if (url.includes('redirect/2')) return resp(200, html('Webber Turmeric - Costco'), 'https://www.costco.ca/p/-/webber/100');
      if (url.includes('redirect/3')) return resp(200, html('Top 10 turmeric supplements'), 'https://blog.example.org/turmeric');
      return resp(404, '', url);
    });
    const refs = await buildReferences(
      { sourceUrl: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/1', chunks: [{ uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/3', title: 'blog.example.org' }, { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/2', title: 'costco.ca' }, { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/4', title: 'dead.example.com' }], brand: 'webber naturals' },
      { safeFetch: fetcher },
    );
    expect(refs.map((r) => [r.kind, r.url])).toEqual([
      ['official', 'https://www.webbernaturals.com/products/turmeric'],
      ['retailer', 'https://www.costco.ca/p/-/webber/100'],
      // the blog is dropped: two reliable sources already exist
    ]);
    expect(refs[0].title).toBe('Advanced Turmeric | Webber Naturals');
  });
  it('drops dead links, unreachable pages and duplicates; never throws', async () => {
    const fetcher = async (url: string) => {
      if (url.includes('/dead')) return resp(404, '', url);
      if (url.includes('/boom')) throw new Error('Address not allowed');
      return resp(200, html('Same page'), 'https://www.santen.com/a');
    };
    const refs = await buildReferences({ sourceUrl: 'https://x.test/dead', chunks: [{ uri: 'https://x.test/boom' }, { uri: 'https://x.test/one' }, { uri: 'https://x.test/two' }], brand: 'Santen' }, { safeFetch: fetcher });
    expect(refs).toEqual([{ url: 'https://www.santen.com/a', title: 'Same page', kind: 'official' }]);
    expect(await buildReferences({}, { safeFetch: fetcher })).toEqual([]);
  });
  it('keeps a blocked-but-existing page (403) so the link is not lost', async () => {
    const refs = await buildReferences({ sourceUrl: 'https://shop.example.com/p', brand: 'x' }, { safeFetch: async (u: string) => resp(403, 'no', u) });
    expect(refs[0].url).toBe('https://shop.example.com/p');
  });
});
