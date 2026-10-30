import { extractImageCandidates, pickProductImage, ImageChooser } from '../utils/pageImage';
import type { SafeResponse } from '../utils/safeFetch';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif')]);

const resp = (status: number, body: Buffer | string, url: string): SafeResponse => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { status, ok: status >= 200 && status < 300, headers: {}, body: b, url, truncated: false, text: () => b.toString('utf8') };
};

describe('extractImageCandidates', () => {
  it('orders schema.org Product images first, then og:image, twitter:image, image_src; resolves relative URLs', () => {
    const html = `
      <meta property="og:image" content="/img/og.jpg">
      <meta name="twitter:image" content="http://cdn.example.com/tw.webp&amp;v=2">
      <link rel="image_src" href="https://cdn.example.com/src.png">
      <script type="application/ld+json">{"@type":"Product","image":["https://cdn.example.com/p1.jpg","/img/p2.jpg"]}</script>`;
    expect(extractImageCandidates(html, 'https://shop.example.com/p/1')).toEqual([
      'https://cdn.example.com/p1.jpg',
      'https://shop.example.com/img/p2.jpg',
      'https://shop.example.com/img/og.jpg',
      'https://cdn.example.com/tw.webp&v=2', // http upgraded to https, entity decoded
      'https://cdn.example.com/src.png',
    ]);
  });

  it('accepts a bare og:image (a vision model judges it later) but ignores Organization images', () => {
    const html = `<meta property="og:image" content="https://cdn.example.com/a.jpg">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":"https://cdn.example.com/logo.png","image":"https://cdn.example.com/org.png"},{"@type":["Thing","Product"],"image":{"url":"https://cdn.example.com/g.jpg"}}]}</script>`;
    expect(extractImageCandidates(html, 'https://x.test/')).toEqual(['https://cdn.example.com/g.jpg', 'https://cdn.example.com/a.jpg']);
  });

  it('drops non-https URLs and duplicates; ignores invalid JSON-LD', () => {
    const html = `<meta property="og:image" content="javascript:alert(1)"><meta property="og:image" content="data:image/png;base64,AAAA">
      <meta property="og:image" content="https://cdn.example.com/a.jpg"><meta name="twitter:image" content="https://cdn.example.com/a.jpg">
      <script type="application/ld+json">{ not json</script>`;
    expect(extractImageCandidates(html, 'https://x.test/')).toEqual(['https://cdn.example.com/a.jpg']);
    expect(extractImageCandidates('<html></html>', 'https://x.test/')).toEqual([]);
  });
});

describe('pickProductImage', () => {
  const other = 'https://www.other.com/p';
  const photo = { base64: 'AAAA', mime: 'image/jpeg' };
  const official = 'https://www.brand.com/p/1';
  const retailer = 'https://shop.example.com/p/1';
  const pageHtml: Record<string, string> = {
    [official]: '<meta property="og:image" content="https://cdn.brand.com/front.jpg"><meta name="twitter:image" content="https://cdn.brand.com/side.jpg">',
    [retailer]: '<meta property="og:image" content="https://cdn.shop.example.com/pack.png">',
  };
  const images: Record<string, Buffer> = {
    'https://cdn.brand.com/front.jpg': JPEG,
    'https://cdn.brand.com/side.jpg': PNG,
    'https://cdn.shop.example.com/pack.png': PNG,
  };
  const fetcher = jest.fn(async (url: string) => {
    if (pageHtml[url]) return resp(200, pageHtml[url], url);
    if (images[url]) return resp(200, images[url], url);
    return resp(404, '', url);
  });
  beforeEach(() => fetcher.mockClear());

  it('lists the official page first, lets the chooser decide, returns the chosen URL', async () => {
    const chooser = jest.fn<ReturnType<ImageChooser>, Parameters<ImageChooser>>(async (_p, cands) => cands.findIndex((c) => c.url.endsWith('front.jpg')));
    const url = await pickProductImage({ pageUrls: [official, retailer], photo, name: 'Turmeric', brand: 'Brand' }, { safeFetch: fetcher, chooser });
    expect(url).toBe('https://cdn.brand.com/front.jpg');
    const [passedPhoto, cands, hint] = chooser.mock.calls[0];
    expect(passedPhoto).toEqual(photo);
    expect(cands.map((c) => c.url)).toEqual(['https://cdn.brand.com/front.jpg', 'https://cdn.shop.example.com/pack.png', 'https://cdn.brand.com/side.jpg']); // interleaved, official first
    expect(cands[0]).toMatchObject({ mime: 'image/jpeg' });
    expect(hint).toEqual({ name: 'Turmeric', brand: 'Brand' });
  });

  it('returns null when the chooser rejects them all or answers out of range', async () => {
    for (const idx of [null, -1, 9, 1.5]) {
      const chooser: ImageChooser = async () => idx as number | null;
      expect(await pickProductImage({ pageUrls: [official], photo }, { safeFetch: fetcher, chooser })).toBeNull();
    }
  });

  it('skips non-raster / unsupported formats and HTML error pages disguised as images', async () => {
    const f = async (url: string) => {
      if (url === official) return resp(200, '<meta property="og:image" content="https://cdn.x.com/a.avif"><meta name="twitter:image" content="https://cdn.x.com/b.jpg"><meta property="og:image" content="https://cdn.x.com/c.png">', url);
      if (url.endsWith('a.avif')) return resp(200, AVIF, url); // not accepted by the vision model
      if (url.endsWith('b.jpg')) return resp(200, '<html>blocked</html>', url);
      return resp(200, PNG, url);
    };
    const chooser = jest.fn(async () => 0);
    expect(await pickProductImage({ pageUrls: [official], photo }, { safeFetch: f, chooser })).toBe('https://cdn.x.com/c.png');
    expect((chooser.mock.calls[0] as unknown as [unknown, Array<{ url: string }>])[1].map((c) => c.url)).toEqual(['https://cdn.x.com/c.png']);
  });

  it('does not call the model when there is nothing to judge', async () => {
    const chooser = jest.fn(async () => 0);
    expect(await pickProductImage({ pageUrls: ['https://empty.example.com/'], photo }, { safeFetch: async (u: string) => resp(200, '<html></html>', u), chooser })).toBeNull();
    expect(chooser).not.toHaveBeenCalled();
  });

  it('never throws: blocked pages, failing downloads and a failing chooser all give null', async () => {
    const boom = async () => {
      throw new Error('Address not allowed');
    };
    expect(await pickProductImage({ pageUrls: ['http://127.0.0.1/'], photo }, { safeFetch: boom, chooser: async () => 0 })).toBeNull();
    const throwingChooser: ImageChooser = async () => {
      throw new Error('model down');
    };
    expect(await pickProductImage({ pageUrls: [official], photo }, { safeFetch: fetcher, chooser: throwingChooser })).toBeNull();
  });

  it('limits pages and candidates', async () => {
    const many = Array.from({ length: 8 }, (_, i) => `https://p${i}.example.com/`);
    const f = jest.fn(async (url: string) => (url.endsWith('/') ? resp(200, `<meta property="og:image" content="${url}img.png">`, url) : resp(200, PNG, url)));
    const chooser = jest.fn(async () => null);
    await pickProductImage({ pageUrls: many, photo }, { safeFetch: f, chooser, maxPages: 4, maxCandidates: 3 });
    const pageCalls = f.mock.calls.filter((c) => (c[0] as string).endsWith('/')).length;
    expect(pageCalls).toBe(4);
    expect((chooser.mock.calls[0] as unknown as [unknown, unknown[]])[1].length).toBeLessThanOrEqual(3);
  });

  it('extra pages are searched only when the given pages gave no candidate, deduped and tried', async () => {
    const blocked = 'https://aeon.example.com/p/1';
    const other = 'https://www.brand.com/p/1';
    const f = jest.fn(async (url: string) => {
      if (url === blocked) return resp(403, 'no', url);
      if (url === other) return resp(200, '<meta property="og:image" content="https://cdn.brand.com/front.jpg">', url);
      if (url === 'https://cdn.brand.com/front.jpg') return resp(200, JPEG, url);
      return resp(404, '', url);
    });
    const morePages = jest.fn(async () => [blocked, other]);
    const chooser = jest.fn(async () => 0);
    const url = await pickProductImage({ pageUrls: [blocked], photo }, { safeFetch: f, chooser, morePages });
    expect(url).toBe('https://cdn.brand.com/front.jpg');
    expect(morePages).toHaveBeenCalledTimes(1);
    expect(f.mock.calls.filter((c) => c[0] === blocked)).toHaveLength(1); // not retried

    morePages.mockClear();
    await pickProductImage({ pageUrls: [other], photo }, { safeFetch: f, chooser, morePages });
    expect(morePages).not.toHaveBeenCalled(); // first pages already had candidates
  });

  it('a failing or empty extra search just gives null', async () => {
    const f = async (u: string) => resp(403, 'no', u);
    const chooser = jest.fn(async () => 0);
    expect(await pickProductImage({ pageUrls: ['https://a.example.com/'], photo }, { safeFetch: f, chooser, morePages: async () => { throw new Error('search down'); } })).toBeNull();
    expect(await pickProductImage({ pageUrls: ['https://a.example.com/'], photo }, { safeFetch: f, chooser, morePages: async () => [] })).toBeNull();
    expect(chooser).not.toHaveBeenCalled();
  });

  it('never offers or returns excluded pictures; falls through to the extra page search when only excluded ones exist', async () => {
    const f = jest.fn(async (url: string) => {
      if (url === official) return resp(200, pageHtml[official], url);
      if (url === 'https://www.other.com/p') return resp(200, '<meta property="og:image" content="https://cdn.other.com/alt.jpg">', url);
      if (url === 'https://cdn.other.com/alt.jpg') return resp(200, JPEG, url);
      if (images[url]) return resp(200, images[url], url);
      return resp(404, '', url);
    });
    const chooser = jest.fn<ReturnType<ImageChooser>, Parameters<ImageChooser>>(async () => 0);
    const exclude = ['https://cdn.brand.com/front.jpg', 'https://cdn.brand.com/side.jpg'];
    const url = await pickProductImage({ pageUrls: [official], photo, excludeUrls: exclude }, { safeFetch: f, chooser, morePages: async () => ['https://www.other.com/p'] });
    expect(url).toBe('https://cdn.other.com/alt.jpg');
    expect(chooser.mock.calls[0][1].map((c) => c.url)).toEqual(['https://cdn.other.com/alt.jpg']);
  });

  it('works without a photo and without page URLs (extra search only)', async () => {
    const f = async (url: string) => (url === other ? resp(200, '<meta property="og:image" content="https://cdn.brand.com/front.jpg">', url) : url.endsWith('front.jpg') ? resp(200, JPEG, url) : resp(404, '', url));
    const chooser = jest.fn<ReturnType<ImageChooser>, Parameters<ImageChooser>>(async () => 0);
    const url = await pickProductImage({ pageUrls: [], photo: null, name: 'Turmeric', brand: 'Brand' }, { safeFetch: f, chooser, morePages: async () => [other] });
    expect(url).toBe('https://cdn.brand.com/front.jpg');
    expect(chooser.mock.calls[0][0]).toBeNull();
  });
});
